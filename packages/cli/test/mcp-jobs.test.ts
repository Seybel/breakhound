import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMcpServer } from '../src/mcp';
import { git, makeRepo } from './repo';
import { StreamTransport } from './transport';

/**
 * A scan or verify that takes longer than an agent's client waits for an answer: the call says
 * it's still running instead of timing out, lookups answer meanwhile, and the same call again
 * collects the result. Answers are due within 300ms here, so a real scan always outlasts them.
 */

const root = makeRepo();
const toServer = new PassThrough();
const fromServer = new PassThrough();
let serverDone: Promise<void>;
const client = new Client({ name: 'test-agent', version: '1.0.0' });
/** What the client found wrong in what the server sent, like progress for a call already answered. */
const clientErrors: string[] = [];
const progress: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, {
    onprogress: (p) => progress.push(p.message ?? ''),
  });
  const content = res.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? '').join('\n'), isError: Boolean(res.isError) };
}

/** Calls the tool again, the way the server asks, until it has the result. */
async function collect(name: string, args: Record<string, unknown> = {}) {
  for (;;) {
    const r = await call(name, args);
    if (!r.text.startsWith('Still running:')) return r;
  }
}

beforeAll(async () => {
  writeFileSync(
    join(root, 'breakhound.config.json'),
    JSON.stringify({ widths: { min: 320, max: 800 }, screenshots: false }),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Add breakhound config');
  process.env.BREAKHOUND_ROOT = root;
  process.env.BREAKHOUND_REPLY_WITHIN_MS = '300';
  serverDone = runMcpServer('test', { input: toServer, output: fromServer });
  delete process.env.BREAKHOUND_REPLY_WITHIN_MS;
  await client.connect(new StreamTransport(toServer, fromServer));
  client.onerror = (error) => clientErrors.push(error.message);
});

afterAll(async () => {
  delete process.env.BREAKHOUND_ROOT;
  await client.close();
  await serverDone;
});

describe('a scan or verify that outlasts the call', () => {
  it('says it is still running, answers lookups meanwhile, and the same call collects it', async () => {
    const first = await call('scan');
    expect(first.text).toMatch(/^Still running: scan has been running for \d+s/);
    expect(first.text).toContain('Call scan again with the same arguments');

    // Lookups don't wait behind it, and say what they're from.
    const issues = await call('list_issues');
    expect(issues.text).toContain('Note: scan has been running');
    // Changes wait for it, and say so instead of timing out.
    const checkpoint = await call('checkpoint', { routes: ['/pricing'] });
    expect(checkpoint.isError).toBe(true);
    expect(checkpoint.text).toMatch(/^Not yet: scan has been running/);
    const other = await call('verify', { routes: ['/pricing'] });
    expect(other.text).toMatch(/^Not yet: scan has been running/);

    const scan = await collect('scan');
    expect(scan.text).toMatch(/Scanned 3 of 3 routes/);

    // Collected, so the next verify starts afresh, and is collected the same way.
    const verify = await collect('verify', { routes: ['/pricing'] });
    expect(verify.isError).toBe(false);
    expect(verify.text).toContain('/pricing');
    expect((await call('list_issues')).text).not.toContain('Note:');

    // Progress reached the calls that were waiting, and only those.
    expect(progress.some((m) => m.startsWith('Scanned') || m.startsWith('Checked'))).toBe(true);
    expect(clientErrors).toEqual([]);
  }, 180_000);
});
