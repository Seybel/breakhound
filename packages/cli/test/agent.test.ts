import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMcpServer } from '../src/mcp';

/**
 * The whole fix loop the way a coding agent drives it over MCP, on a made-up
 * app in a throwaway git repo: scan, fix, verify, checkpoint, catch a
 * regression, and undo one route's fix.
 */

/** Pages are read from disk on every request, so edits show up like with a dev server's hot reload. */
const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const name = path === '/' ? 'home' : path.slice(1);
  let body;
  try { body = readFileSync('pages/' + name + '.html', 'utf8'); } catch { res.writeHead(404); res.end('Not found'); return; }
  const css = readFileSync('styles.css', 'utf8');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}' + css + '</style></head><body><main>' + body + '<nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav></main></body></html>');
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/'));
`;

const CSS = {
  broken: '.banner { width: 600px; background: #eee }\n.card { width: 520px; background: #ddd }\n',
  pricingFixed:
    '.banner { max-width: 600px; background: #eee }\n.card { width: 520px; background: #ddd }\n',
};

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'breakhound-agent-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'shop', scripts: { dev: 'node server.mjs' } }),
  );
  writeFileSync(join(root, 'server.mjs'), SERVER);
  writeFileSync(join(root, '.gitignore'), '.breakhound/\n');
  writeFileSync(join(root, 'styles.css'), CSS.broken);
  mkdirSync(join(root, 'pages'));
  writeFileSync(join(root, 'pages/home.html'), '<h1>Shop</h1><div class="home">Welcome</div>');
  writeFileSync(
    join(root, 'pages/pricing.html'),
    '<h1>Pricing</h1><div class="banner">Plans for everyone</div>',
  );
  writeFileSync(join(root, 'pages/about.html'), '<h1>About</h1><div class="card">Our story</div>');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Start');
  return root;
}

/** An MCP client transport over a pair of in-memory streams. */
class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = '';
  constructor(
    private readonly toServer: PassThrough,
    private readonly fromServer: PassThrough,
  ) {}
  async start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let i = this.buffer.indexOf('\n'); i !== -1; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line));
      }
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }
  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}

const root = makeRepo();
const toServer = new PassThrough();
const fromServer = new PassThrough();
let serverDone: Promise<void>;
const client = new Client({ name: 'test-agent', version: '1.0.0' });
const QUICK = JSON.stringify({ widths: { min: 320, max: 800 }, screenshots: false });

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const content = res.content as { type: string; text?: string }[];
  const out = content.map((c) => c.text ?? '').join('\n');
  if (res.isError) throw new Error(out);
  return out;
}

beforeAll(async () => {
  writeFileSync(join(root, 'breakhound.config.json'), QUICK);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Add breakhound config');
  process.env.BREAKHOUND_ROOT = root;
  serverDone = runMcpServer('test', { input: toServer, output: fromServer });
  await client.connect(new StreamTransport(toServer, fromServer));
});

afterAll(async () => {
  delete process.env.BREAKHOUND_ROOT;
  await client.close();
  await serverDone;
});

describe('an agent fixing issues over MCP', () => {
  it('lists the tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'checkpoint',
      'get_issue',
      'list_issues',
      'list_routes',
      'scan',
      'undo',
      'verify',
    ]);
    expect(client.getInstructions()).toContain('verify');
  });

  it('fixes, verifies, checkpoints, catches a regression and undoes one route', async () => {
    const scan = await call('scan');
    expect(scan).toMatch(/Scanned 3 of 3 routes/);
    const pricingId = scan.match(/^- (\w+) \[error\].*\.banner/m)?.[1];
    expect(pricingId).toBeTruthy();
    expect(scan).toMatch(/\.card/);

    const detail = await call('get_issue', { id: pricingId });
    expect(detail).toContain('600px');

    // The agent fixes /pricing and checks it.
    writeFileSync(join(root, 'styles.css'), CSS.pricingFixed);
    const v1 = await call('verify', { routes: ['/pricing'] });
    expect(v1).toContain('Fixed: 1 · Still there: 0 · New: 0');
    expect(v1).toContain('checkpoint');
    const c1 = await call('checkpoint', { routes: ['/pricing'] });
    expect(c1).toMatch(/Committed \w+: Fix responsive layout on \/pricing/);
    const message = git(root, 'log', '-1', '--format=%B');
    expect(message).toContain('Breakhound-Route: /pricing');
    expect(message).toMatch(/- \/pricing 3\d\d–\d+px: /);

    // Fixing /about, it breaks the home page at the same time.
    writeFileSync(
      join(root, 'styles.css'),
      `${CSS.pricingFixed.replace('width: 520px', 'max-width: 520px')}.home { width: 700px }\n`,
    );
    const v2 = await call('verify');
    // Always compared with the first scan, so /pricing still counts as fixed.
    expect(v2).toContain('Fixed: 2 · Still there: 0 · New: 1');
    expect(v2).toMatch(/New since that scan[\s\S]*- \/ .*\.home/);
    expect(v2).toContain('Not done yet');

    // It fixes that too, and the whole app is clean against the first scan.
    writeFileSync(
      join(root, 'styles.css'),
      `${CSS.pricingFixed.replace('width: 520px', 'max-width: 520px')}.home { max-width: 700px }\n`,
    );
    const v3 = await call('verify');
    expect(v3).toContain('Fixed: 2 · Still there: 0 · New: 0');
    expect(v3).toContain('Nothing left to fix');
    await call('checkpoint', { routes: ['/about', '/'] });

    // Undo only /pricing: its issue comes back, /about stays fixed.
    const listed = await call('undo');
    expect(listed).toMatch(/\/pricing/);
    const u = await call('undo', { routes: ['/pricing'] });
    expect(u).toContain('Undid 1 fix');
    expect(git(root, 'show', 'HEAD:styles.css')).toContain('.banner { width: 600px');
    expect(git(root, 'show', 'HEAD:styles.css')).toContain('max-width: 520px');
    const v4 = await call('verify');
    expect(v4).toContain('Fixed: 1 · Still there: 1 · New: 0');
  });

  it("never commits changes the user had before the scan, and won't undo over uncommitted work", async () => {
    writeFileSync(join(root, 'notes.txt'), 'my own work in progress\n');
    await call('scan', { routes: ['/about'] });
    writeFileSync(join(root, 'styles.css'), '.banner { max-width: 600px }\n');
    await expect(call('checkpoint', { routes: ['/pricing'] })).rejects.toThrow(/notes\.txt/);
    await expect(call('undo', { routes: ['/about'] })).rejects.toThrow(/uncommitted changes/);
    // Naming its own files, the agent can still commit its fix without the user's work.
    await call('checkpoint', { routes: ['/pricing'], files: ['styles.css'] });
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('styles.css');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Fix responsive layout on /pricing');
    // The user's file is still theirs, uncommitted.
    expect(git(root, 'status', '--porcelain')).toBe('?? notes.txt');
  });
});
