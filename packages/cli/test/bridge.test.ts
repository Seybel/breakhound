import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createScanResult, type Issue, type RouteResult } from '@breakhound/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Bridge, EXTENSION_IDS, NoPanelError, startBridge } from '../src/bridge';
import { loadConfig } from '../src/config';
import { formatVerify, runVerify, severitiesAtOrAbove } from '../src/verify';
import { makeRepo } from './repo';

const ORIGIN = `chrome-extension://${EXTENSION_IDS[0]}`;
const SITE = 'http://127.0.0.1:4999';

function issue(selector: string, detector: Issue['detector'] = 'page-overflow'): Issue {
  return {
    id: createHash('sha1').update(selector).digest('hex').slice(0, 12),
    fingerprint: selector,
    detector,
    severity: detector === 'tiny-text' ? 'info' : 'error',
    title: `Something about ${selector}`,
    ranges: [{ from: 320, to: 400 }],
    worstAt: 320,
    element: {
      selector,
      path: selector,
      html: `<div class="${selector.slice(1)}">`,
      text: 'Plans',
      source: { file: `${'/somewhere/else'}/src/App.tsx`, line: 3, column: 1, exact: true },
    },
    evidence: {},
    styles: {},
  } as Issue;
}

function page(route: string, issues: Issue[]): RouteResult {
  return {
    route,
    url: `${SITE}${route}`,
    finalUrl: `${SITE}${route}`,
    status: 'scanned',
    pageErrors: [],
    warnings: [],
    breakpoints: { observed: [], declared: [], unexplained: [] },
    issues,
    measurements: 40,
    durationMs: 1000,
  };
}

/** A scan the way the panel sends it. */
function panelScan(routes: RouteResult[]) {
  return createScanResult(routes, {
    version: '1.0.0',
    startedAt: new Date(),
    minWidth: 320,
    maxWidth: 1440,
    step: 16,
    baseUrl: SITE,
  });
}

/** A request the way a browser makes it: an Origin, and a Host the bridge checks. */
function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = { origin: ORIGIN },
  method = 'POST',
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/breakhound/${path}`,
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data ? JSON.parse(data) : {},
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify(body) : undefined);
  });
}

/** Ports of their own, so a breakhound the developer has running is never in the way. */
const PORTS = Array.from({ length: 5 }, (_, i) => 52_000 + Math.floor(Math.random() * 5000) + i);

let root: string;
let bridge: Bridge;

beforeAll(async () => {
  root = makeRepo();
  writeFileSync(
    join(root, 'breakhound.config.json'),
    JSON.stringify({ baseUrl: SITE, detectors: { 'tiny-text': false, overlap: 'warning' } }),
  );
  const started = await startBridge({
    root,
    version: '1.0.0',
    loadConfig: async () => (await loadConfig(root)).config,
    ports: PORTS,
    pickupMs: 1500,
  });
  if (!started) throw new Error('No free port');
  bridge = started;
});

afterAll(async () => {
  await bridge?.close();
});

describe('the bridge to the browser extension', () => {
  it("has the id the extension's manifest key gives it", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../extension/static/manifest.json'), 'utf8'),
    );
    const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
    const id = [...digest.slice(0, 32)]
      .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
      .join('');
    expect(EXTENSION_IDS).toContain(id);
  });

  it('answers only the breakhound extension, on this machine', async () => {
    const hello = await post(bridge.port, 'hello', {});
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ name: 'breakhound', project: 'shop', root });
    expect(hello.headers['access-control-allow-origin']).toBe(ORIGIN);

    // A web page, another extension, or a local script without the extension's origin.
    for (const origin of [
      'https://evil.example',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    ]) {
      expect((await post(bridge.port, 'hello', {}, { origin })).status).toBe(403);
    }
    expect((await post(bridge.port, 'hello', {}, {})).status).toBe(403);
    // A site that points its own name at 127.0.0.1 (DNS rebinding) sends its own Host.
    expect(
      (await post(bridge.port, 'hello', {}, { origin: ORIGIN, host: 'evil.example' })).status,
    ).toBe(403);

    const preflight = await post(bridge.port, 'scan', null, { origin: ORIGIN }, 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
  });

  it("knows a page is its project's when the config names the site", async () => {
    expect((await post(bridge.port, 'match', { url: `${SITE}/pricing` })).body.matches).toBe(true);
    expect((await post(bridge.port, 'match', { url: 'http://127.0.0.1:5999/' })).body.matches).toBe(
      false,
    );
  });

  it("refuses a scan that isn't well formed, and writes nothing", async () => {
    const bad = panelScan([page('/', [issue('.banner')])]);
    (bad.routes[0]?.issues[0] as unknown as Record<string, unknown>).detector = 'made-up';
    const res = await post(bridge.port, 'scan', { result: bad });
    expect(res.status).toBe(400);
    expect(existsSync(join(root, '.breakhound/result.json'))).toBe(false);
  });

  it("saves a sent scan as the baseline, with the project's own settings", async () => {
    const sent = panelScan([
      page('/', [issue('.banner'), issue('.legal', 'tiny-text')]),
      page('/pricing', [issue('.card', 'overlap')]),
    ]);
    const res = await post(bridge.port, 'scan', { result: sent });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ routes: 2, issues: 2 });

    const saved = JSON.parse(readFileSync(join(root, '.breakhound/baseline.json'), 'utf8'));
    expect(saved.from).toBe('extension');
    const issues = saved.routes.flatMap((r: RouteResult) => r.issues) as Issue[];
    // tiny-text is turned off in the config, and overlap is downgraded.
    expect(issues.map((i) => i.detector).sort()).toEqual(['overlap', 'page-overflow']);
    expect(issues.find((i) => i.detector === 'overlap')?.severity).toBe('warning');
    // A source file outside the project isn't passed on as if it were in it.
    expect(issues[0]?.element.source).toBeNull();
    expect(existsSync(join(root, '.breakhound/prompt.md'))).toBe(true);
  });

  it("checks the agent's fixes in the browser panel, and says so when there's none", async () => {
    const { config } = await loadConfig(root);
    const verify = (scanPages: Parameters<typeof runVerify>[0]['scanPages']) =>
      runVerify({
        cwd: root,
        config,
        version: '1.0.0',
        quiet: true,
        ...(scanPages ? { scanPages } : {}),
      });

    // Not without a browser to check in.
    await expect(verify(undefined)).rejects.toThrow(/sent from the breakhound extension/);
    await expect(
      verify((pages, widths) => bridge.scanInBrowser(pages, widths, SITE)),
    ).rejects.toBeInstanceOf(NoPanelError);

    // A panel open on the site: it takes the check, scans, and sends the pages back.
    const panel = (async () => {
      const { body } = await post(bridge.port, 'checks', { origin: SITE });
      const check = body.check as {
        id: string;
        pages: { route: string; url: string }[];
        widths: { minWidth: number; maxWidth: number };
      };
      expect(check.widths).toEqual({ minWidth: 320, maxWidth: 1440 });
      expect(check.pages.map((p) => p.route).sort()).toEqual(['/', '/pricing']);
      // The banner is fixed; the card still overlaps.
      const routes = [page('/', []), page('/pricing', [issue('.card', 'overlap')])];
      await post(bridge.port, 'checks/done', { id: check.id, routes });
    })();
    const v = await verify((pages, widths) => bridge.scanInBrowser(pages, widths, SITE));
    await panel;
    expect(v.fixed.map((c) => c.issue.element.selector)).toEqual(['.banner']);
    expect(v.failing.map((c) => c.issue.element.selector)).toEqual(['.card']);
    expect(v.regressions).toEqual([]);
    expect(formatVerify(v, severitiesAtOrAbove('warning'))).toContain('Fixed: 1 · Still there: 1');
  });

  it('only gives a check to a panel on the same site', async () => {
    const elsewhere = post(bridge.port, 'checks', { origin: 'http://127.0.0.1:7000' });
    const checking = bridge.scanInBrowser(
      [{ route: '/', url: `${SITE}/` }],
      {
        minWidth: 320,
        maxWidth: 800,
      },
      SITE,
    );
    await expect(checking).rejects.toBeInstanceOf(NoPanelError);
    // The other panel is still waiting, empty handed, when the bridge closes.
    await bridge.close();
    expect((await elsewhere).body.check).toBeNull();
  });
});
