import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveServer } from '../src/app';
import {
  guard,
  MemoryError,
  measure,
  measureNow,
  type Proc,
  parseFootprint,
  parseMemoryLimit,
  parsePs,
} from '../src/guard';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('memoryLimit', () => {
  it('defaults to 60% of memory, keeping at least 2 GB free', () => {
    expect(parseMemoryLimit(undefined, 16 * GB)).toBeCloseTo(9.6 * GB);
    expect(parseMemoryLimit(undefined, 8 * GB)).toBeCloseTo(4.8 * GB);
    expect(parseMemoryLimit(undefined, 4 * GB)).toBe(2 * GB);
    expect(parseMemoryLimit(undefined, 2 * GB)).toBe(2 * GB);
  });

  it('takes sizes, shares and off', () => {
    expect(parseMemoryLimit('6GB', 16 * GB)).toBe(6 * GB);
    expect(parseMemoryLimit('1.5 gb', 16 * GB)).toBe(1.5 * GB);
    expect(parseMemoryLimit('512MB', 16 * GB)).toBe(512 * MB);
    expect(parseMemoryLimit('50%', 16 * GB)).toBe(8 * GB);
    expect(parseMemoryLimit('off')).toBeNull();
    expect(parseMemoryLimit(false)).toBeNull();
    expect(() => parseMemoryLimit('lots')).toThrow(/6GB/);
    expect(() => parseMemoryLimit('0GB')).toThrow(/more than 0/);
  });
});

describe('measuring what breakhound runs', () => {
  const proc = (pid: number, ppid: number, pgid: number, mb: number, command: string): Proc => ({
    pid,
    ppid,
    pgid,
    rss: mb * MB,
    command,
  });

  it('reads ps output', () => {
    expect(parsePs('  12   1  12  2048 /usr/bin/node server.js\n bad line\n')).toEqual([
      proc(12, 1, 12, 2, '/usr/bin/node server.js'),
    ]);
  });

  it("reads macOS's footprint, which counts compressed memory", () => {
    const out = `======
node [2685]: 64-bit    Footprint: 221844416 B (16384 bytes per page)
======
      Dirty         Clean
headless_shell [2687]: 64-bit    Footprint: 1048576 B (16384 bytes per page)
`;
    expect(parseFootprint(out)).toEqual(
      new Map([
        [2685, 221844416],
        [2687, 1048576],
      ]),
    );
  });

  it("counts the dev server's whole group, the browser and breakhound, and nothing else", () => {
    const procs = [
      proc(1, 0, 1, 10, 'launchd'),
      proc(100, 1, 100, 200, 'node breakhound'),
      // The dev server: a shell, then npm, then next; next-server outlived its parent.
      proc(200, 100, 200, 5, 'sh'),
      proc(201, 200, 200, 50, 'npm'),
      proc(202, 201, 200, 3000, 'next-server'),
      proc(203, 1, 200, 800, 'next-server worker'),
      // Playwright's browser, in its own group.
      proc(300, 100, 300, 150, 'headless_shell'),
      proc(301, 300, 300, 400, 'headless_shell --type=renderer'),
      // Firefox, when scanning in more than one browser.
      proc(302, 100, 302, 300, '/cache/ms-playwright/firefox-1/Nightly.app/Contents/MacOS/firefox'),
      // Someone else's.
      proc(400, 1, 400, 6000, 'Slack'),
    ];
    const usage = measure(procs, 100, new Set([200]));
    expect(usage.devServer).toBe(3855 * MB);
    expect(usage.browser).toBe(850 * MB);
    expect(usage.other).toBe(200 * MB);
    expect(usage.total).toBe(4905 * MB);
    // Never breakhound itself, never anything it didn't start.
    expect(usage.killable.map((p) => p.pid).sort()).toEqual([200, 201, 202, 203, 300, 301, 302]);
  });
});

describe('the memory guard', () => {
  it('lets work that stays under the limit finish', async () => {
    await expect(guard.run({ limit: 64 * GB }, async () => 'done')).resolves.toBe('done');
  });

  it('stops when the system is out of memory for a few seconds in a row', async () => {
    const procs = (): Proc[] => [
      { pid: process.pid, ppid: 1, pgid: process.pid, rss: 2 * GB, command: 'node' },
    ];
    const run = guard.run(
      {
        limit: 64 * GB,
        intervalMs: 20,
        probe: { processes: async () => procs(), critical: async () => true },
      },
      () => new Promise((r) => setTimeout(r, 5000)),
    );
    await expect(run).rejects.toThrow(/running out of memory/);
  });

  it('shuts down a dev server that grows past the limit while it starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'breakhound-guard-'));
    // Grabs about 600 MB, the way a big app's first compile can, and never answers.
    writeFileSync(
      join(dir, 'hog.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('pid', String(process.pid));
const keep = [];
for (let i = 0; i < 12; i++) keep.push(Buffer.alloc(50 * 1024 * 1024, 1));
setInterval(() => keep.length, 1000);
`,
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hog' }));
    // Measured the same way the guard does, so the test runner's own size doesn't matter.
    const before = await measureNow();
    const limit = (before?.total ?? process.memoryUsage.rss()) + 300 * MB;
    const started = Date.now();
    const error = await guard
      .run({ limit }, () =>
        resolveServer(dir, { server: { command: 'node hog.mjs', timeout: 60 } }, true),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as Error).message).toMatch(/Most of it was the dev server/);
    expect((error as MemoryError).usage.devServer).toBeGreaterThan(300 * MB);
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});
