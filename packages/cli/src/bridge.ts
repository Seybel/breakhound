import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { BRIDGE_PORTS, DETECTOR_IDS, type RouteResult, type ScanResult } from '@breakhound/engine';
import { detectProject, servesProject } from '@breakhound/routes';
import type { BreakhoundConfig } from './config';
import { saveExtensionScan } from './scan';

/**
 * The breakhound extension's id in the Chrome Web Store. Unpacked builds have it too, since the
 * manifest carries the store's public key, and a test checks the two match. A fork or another
 * build can be let in with BREAKHOUND_EXTENSION_ID, comma separated.
 */
export const EXTENSION_IDS = ['ddnmhnjmcokbfabeileblceehjhefkpc'];

/** A panel asks for work this long at a time, and asks again. */
const POLL_MS = 25_000;
/** How long a check waits for a panel to take it. */
const PICKUP_MS = 20_000;
/** And how long the panel gets to scan, once it has. */
const CHECK_MS = 20 * 60_000;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_ROUTES = 200;

/** No breakhound panel is open on the site to check the pages in. */
export class NoPanelError extends Error {}

export interface Bridge {
  port: number;
  /** Scans pages in an open breakhound panel on this origin, the way it scanned them first. */
  scanInBrowser(
    pages: { route: string; url: string }[],
    widths: { minWidth: number; maxWidth: number },
    origin: string,
    onProgress?: (done: number, message: string) => void,
  ): Promise<RouteResult[]>;
  close(): Promise<void>;
}

export interface BridgeOptions {
  root: string;
  version: string;
  loadConfig(): Promise<BreakhoundConfig>;
  ports?: readonly number[];
  pickupMs?: number;
  /** Told when the developer sends a scan, so the agent's session can say so. */
  onScan?: (result: ScanResult) => void;
}

interface Check {
  id: string;
  origin: string;
  pages: { route: string; url: string }[];
  widths: { minWidth: number; maxWidth: number };
  taken: boolean;
  timer: NodeJS.Timeout;
  onProgress?: ((done: number, message: string) => void) | undefined;
  resolve(routes: RouteResult[]): void;
  reject(error: Error): void;
}

interface Waiter {
  origin: string;
  give(check: Check | null): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function allowedOrigins(): Set<string> {
  const ids = [
    ...EXTENSION_IDS,
    ...(process.env.BREAKHOUND_EXTENSION_ID ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  return new Set(ids.map((id) => `chrome-extension://${id}`));
}

/** What the developer calls the project: its package name, or its folder. */
function projectName(root: string): string {
  try {
    const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name) return name;
  } catch {
    // No package.json, or not JSON.
  }
  return basename(root);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Too big'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const SEVERITIES = new Set(['error', 'warning', 'info']);
const STATUSES = new Set(['scanned', 'error', 'empty', 'login', 'redirect', 'skipped']);

/** The issues a panel sends become what the agent works from, so only well-formed ones get in. */
function checkRoutes(value: unknown): RouteResult[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTES) throw new HttpError(400, 'Bad routes');
  for (const r of value) {
    if (
      !isObject(r) ||
      typeof r.route !== 'string' ||
      typeof r.url !== 'string' ||
      typeof r.status !== 'string' ||
      !STATUSES.has(r.status) ||
      !Array.isArray(r.issues)
    ) {
      throw new HttpError(400, 'Bad route');
    }
    for (const i of r.issues) {
      const element = isObject(i) ? i.element : null;
      if (
        isObject(i) &&
        typeof i.detector === 'string' &&
        !DETECTOR_IDS.includes(i.detector as never)
      ) {
        throw new HttpError(
          400,
          `This project's breakhound doesn't know the check "${i.detector.slice(0, 40)}" yet. Restart your agent with the latest breakhound to send it.`,
        );
      }
      if (
        !isObject(i) ||
        typeof i.id !== 'string' ||
        typeof i.title !== 'string' ||
        !DETECTOR_IDS.includes(i.detector as never) ||
        !SEVERITIES.has(String(i.severity)) ||
        !Array.isArray(i.ranges) ||
        !isObject(element) ||
        typeof element.selector !== 'string'
      ) {
        throw new HttpError(400, 'Bad issue');
      }
    }
  }
  return value as RouteResult[];
}

function checkScan(value: unknown): ScanResult {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.settings)) {
    throw new HttpError(400, 'Bad scan');
  }
  const { minWidth, maxWidth, step } = value.settings;
  if (![minWidth, maxWidth, step].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new HttpError(400, 'Bad settings');
  }
  checkRoutes(value.routes);
  const baseUrl = isObject(value.project) ? value.project.baseUrl : null;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new HttpError(400, 'Bad site');
  }
  return value as unknown as ScanResult;
}

/**
 * Lets the breakhound extension hand its scans to the agent working in this project, and check
 * the agent's fixes in the browser. It listens on 127.0.0.1 only, answers only the breakhound
 * extension (its origin can't be faked by a web page), and only ever writes a scan into
 * breakhound's own folder: it never reads or returns the project's files.
 */
export async function startBridge(opts: BridgeOptions): Promise<Bridge | null> {
  const origins = allowedOrigins();
  const checks = new Map<string, Check>();
  const waiters: Waiter[] = [];
  const pickupMs = opts.pickupMs ?? PICKUP_MS;
  let port = 0;

  const handOut = (check: Check): boolean => {
    const i = waiters.findIndex((w) => w.origin === check.origin);
    if (i < 0) return false;
    const [waiter] = waiters.splice(i, 1);
    take(check);
    waiter?.give(check);
    return true;
  };

  const take = (check: Check) => {
    check.taken = true;
    clearTimeout(check.timer);
    check.timer = setTimeout(() => {
      checks.delete(check.id);
      check.reject(new Error('The browser took too long to check the pages.'));
    }, CHECK_MS);
  };

  async function route(path: string, body: Record<string, unknown>, res: ServerResponse) {
    const reply = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    switch (path) {
      case '/breakhound/hello':
        return reply({
          name: 'breakhound',
          version: opts.version,
          root: opts.root,
          project: projectName(opts.root),
          // So a newer extension sends only checks this version knows.
          detectors: DETECTOR_IDS,
        });
      case '/breakhound/match': {
        if (typeof body.url !== 'string') throw new HttpError(400, 'No url');
        const config = await opts.loadConfig();
        let matches = false;
        try {
          const origin = new URL(body.url).origin;
          if (config.baseUrl && new URL(config.baseUrl).origin === origin) matches = true;
        } catch {
          throw new HttpError(400, 'Bad url');
        }
        if (!matches) {
          const project = detectProject(opts.root);
          if (project && config.server?.port) project.configuredPorts.push(config.server.port);
          matches = !!project && (await servesProject(project, body.url));
        }
        return reply({ matches });
      }
      case '/breakhound/scan': {
        const sent = checkScan(body.result);
        const config = await opts.loadConfig();
        const result = await saveExtensionScan(sent, config, opts.root);
        opts.onScan?.(result);
        return reply({
          routes: result.routes.length,
          issues: result.summary.uniqueIssues,
          bySeverity: result.summary.bySeverity,
        });
      }
      case '/breakhound/checks': {
        if (typeof body.origin !== 'string') throw new HttpError(400, 'No origin');
        const origin = body.origin;
        const ready = [...checks.values()].find((c) => !c.taken && c.origin === origin);
        const send = (check: Check | null) =>
          reply({
            check: check ? { id: check.id, pages: check.pages, widths: check.widths } : null,
          });
        if (ready) {
          take(ready);
          return send(ready);
        }
        await new Promise<void>((done) => {
          const waiter: Waiter = {
            origin,
            give: (check) => {
              clearTimeout(timer);
              send(check);
              done();
            },
          };
          const timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            send(null);
            done();
          }, POLL_MS);
          // The panel went away (closed, or the page reloaded) while waiting.
          res.on('close', () => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) {
              waiters.splice(i, 1);
              clearTimeout(timer);
              done();
            }
          });
          waiters.push(waiter);
        });
        return;
      }
      case '/breakhound/checks/progress': {
        const check = checks.get(String(body.id));
        if (check && typeof body.done === 'number' && typeof body.message === 'string') {
          check.onProgress?.(body.done, body.message.slice(0, 400));
        }
        return reply({});
      }
      case '/breakhound/checks/done': {
        const check = checks.get(String(body.id));
        if (!check) throw new HttpError(404, 'No such check');
        checks.delete(check.id);
        clearTimeout(check.timer);
        if (typeof body.error === 'string') check.reject(new Error(body.error.slice(0, 500)));
        else {
          // What can't be taken still ends the check, so verify hears why instead of waiting on.
          try {
            check.resolve(checkRoutes(body.routes));
          } catch (error) {
            check.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        }
        return reply({});
      }
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    // A page on another site could aim a request here, or rebind a domain name to this address.
    const host = req.headers.host ?? '';
    if (!origins.has(origin) || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    readBody(req)
      .then((body) =>
        route(new URL(req.url ?? '/', 'http://x').pathname, isObject(body) ? body : {}, res),
      )
      .catch((error: unknown) => {
        if (res.headersSent) return;
        const status = error instanceof HttpError ? error.status : 500;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  server.keepAliveTimeout = POLL_MS + 5000;
  server.requestTimeout = 0;

  for (const candidate of opts.ports ?? BRIDGE_PORTS) {
    const ok = await new Promise<boolean>((resolve) => {
      const failed = () => resolve(false);
      server.once('error', failed);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', failed);
        resolve(true);
      });
    });
    if (ok) {
      port = candidate;
      break;
    }
  }
  if (!port) return null;

  return {
    port,
    scanInBrowser(pages, widths, origin, onProgress) {
      return new Promise<RouteResult[]>((resolve, reject) => {
        const check: Check = {
          id: randomUUID(),
          origin,
          pages,
          widths,
          taken: false,
          onProgress,
          resolve,
          reject,
          timer: setTimeout(() => {
            if (check.taken) return;
            checks.delete(check.id);
            reject(
              new NoPanelError(
                `No breakhound panel is open on ${origin} to check the pages in. Ask the developer to open breakhound on that site (the breakhound tab in DevTools, or right-click the page and choose Scan with breakhound) and leave it open, then verify again. Or call scan to start over with a headless browser instead.`,
              ),
            );
          }, pickupMs),
        };
        checks.set(check.id, check);
        handOut(check);
      });
    },
    async close() {
      for (const check of checks.values()) {
        clearTimeout(check.timer);
        check.reject(new Error('breakhound is shutting down.'));
      }
      checks.clear();
      for (const w of waiters.splice(0)) w.give(null);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
