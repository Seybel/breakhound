import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import type { FrameworkId, Project } from './project';

const PROBE_TIMEOUT_MS = 1500;
const MAX_BODY = 256 * 1024;

interface Probe {
  status: number;
  html: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Loads a URL the way a quick look would: follows redirects and reads the
 * start of the HTML. Uses node:http rather than fetch so local dev servers
 * with self-signed certificates answer too, like they do in the browser.
 */
function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS, redirects = 5): Promise<Probe | null> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const get = target.protocol === 'https:' ? httpsGet : httpGet;
    const req = get(
      target,
      { headers: { accept: 'text/html' }, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          resolve(probe(new URL(location, target).href, timeoutMs, redirects - 1));
          return;
        }
        let html = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          html += chunk;
          if (html.length >= MAX_BODY) res.destroy();
        });
        const done = () => resolve({ status, html, headers: res.headers });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Markers each framework's dev server leaves in the HTML it serves. */
const FINGERPRINTS: Partial<Record<FrameworkId, RegExp>> = {
  next: /\/_next\/|__NEXT_DATA__|next-route-announcer/,
  nuxt: /\/_nuxt\/|__NUXT__|id="__nuxt"/,
  sveltekit: /__sveltekit|data-sveltekit/,
  astro: /astro-island|data-astro-|\/@id\/astro:|\/_astro\/|content="Astro/,
  remix: /__remixContext|__reactRouterContext|virtual:remix|virtual:react-router/,
  'react-router': /__reactRouterContext|virtual:react-router/,
  angular: /<app-root|ng-version|\/@vite\/client/,
  gatsby: /___gatsby|gatsby-/,
};

/** For plain Vite apps: the dev server serves the project's own index.html, with its entry script. */
function viteEntry(root: string): string | null {
  const html = join(root, 'index.html');
  if (!existsSync(html)) return null;
  return (
    readFileSync(html, 'utf8').match(
      /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/,
    )?.[1] ?? null
  );
}

/** Whether the page served on a port is this project, not some other app left running. */
export function looksLikeProject(project: Project, page: Probe): boolean {
  const { html, headers } = page;
  if (project.framework.id === 'next' && /next\.js/i.test(String(headers['x-powered-by'] ?? '')))
    return true;
  const fingerprint = FINGERPRINTS[project.framework.id];
  if (fingerprint) return fingerprint.test(html);
  const entry = viteEntry(project.root);
  if (entry) return html.includes(entry);
  if (/react-scripts/.test(project.devScript?.command ?? ''))
    return /\/static\/js\/bundle\.js/.test(html);
  // Unknown setup: any HTML page will do.
  return /<html|<!doctype html/i.test(html);
}

/** Whether anything answers at this URL. */
export async function isReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  const page = await probe(url, timeoutMs);
  return page !== null;
}

export interface RunningServer {
  url: string;
  /** Set when breakhound started the server itself. */
  command?: string;
  stop(): Promise<void>;
}

/** Looks for this project's dev server on the usual ports. */
export async function findRunningServer(project: Project): Promise<RunningServer | null> {
  const hosts = ['localhost', '127.0.0.1'];
  const checks = project.ports.flatMap((port) => hosts.map((host) => ({ port, host })));
  const results = await Promise.all(
    checks.map(async ({ port, host }) => {
      const url = `http://${host}:${port}`;
      const page = await probe(`${url}/`);
      return page && page.status < 500 && looksLikeProject(project, page) ? url : null;
    }),
  );
  // Keep the preferred port order; prefer "localhost" on the same port.
  const url = results.find(Boolean);
  return url ? { url, stop: async () => {} } : null;
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal colour codes.
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):\d{2,5}[^\s]*/;

export interface StartOptions {
  /** Command to run instead of the package.json dev script. */
  command?: string;
  /** Fixed port to wait on, when the command doesn't print its URL. */
  port?: number;
  timeoutMs?: number;
  /** Receives the server's output, for troubleshooting. */
  onOutput?: (line: string) => void;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode !== null) return;
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // The server was started in its own process group so its children go too,
      // even when the shell that started them has already exited.
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
}

/** Whether the server, or anything it started, is still running. */
function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the dev server, waits until it answers, and returns how to stop it. */
export async function startServer(
  project: Project,
  options: StartOptions = {},
): Promise<RunningServer> {
  const command =
    options.command ??
    (project.devScript ? `${project.packageManager} run ${project.devScript.name}` : null);
  if (!command) {
    throw new Error(
      'No dev server is running and there is no "dev" script to start one. Start your app, then pass its URL: npx breakhound http://localhost:3000',
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const child = spawn(command, {
    cwd: project.root,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const cleanup = () => killTree(child);
  process.once('exit', cleanup);

  const output: string[] = [];
  let printedUrl: string | null = null;
  const onData = (chunk: Buffer) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      const line = stripAnsi(raw).trim();
      if (!line) continue;
      output.push(line);
      if (output.length > 40) output.shift();
      options.onOutput?.(line);
      const found = line.match(LOCAL_URL)?.[0];
      if (found && !printedUrl)
        printedUrl = found.replace('0.0.0.0', 'localhost').replace(/\/$/, '');
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const stop = async () => {
    process.removeListener('exit', cleanup);
    killTree(child);
    // Give it a moment to shut down cleanly; some servers ignore SIGTERM, or
    // leave children behind once the shell that started them has exited.
    for (let waited = 0; waited < 5000 && groupAlive(child); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (groupAlive(child)) killTree(child, 'SIGKILL');
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The dev server (${command}) stopped before it was ready:\n${output.slice(-15).join('\n')}`,
      );
    }
    // Set from the output handler, which TypeScript can't see.
    const printed = printedUrl as string | null;
    const candidates = printed
      ? [printed.replace(/\/+$/, '')]
      : options.port
        ? [`http://localhost:${options.port}`]
        : [];
    for (const url of candidates) {
      // The first request can be slow while the dev server compiles the page.
      const page = await probe(`${url}/`, 30_000);
      if (page && page.status < 500) return { url, command, stop };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await stop();
  throw new Error(
    `The dev server (${command}) didn't answer within ${Math.round(timeoutMs / 1000)}s.${output.length ? `\n${output.slice(-15).join('\n')}` : ''}`,
  );
}
