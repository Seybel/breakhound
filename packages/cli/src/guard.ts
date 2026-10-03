import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/**
 * Keeps a scan from taking the computer down with it. A big app's dev server
 * (plus the browser measuring it) can eat memory until the machine starts
 * swapping and freezes. While breakhound is working, this checks every
 * second how much memory the processes it started are using, and how the
 * system as a whole is doing. If either goes too far, it kills the dev server
 * and browser at once and the scan stops with an explanation.
 *
 * Only processes breakhound started are ever killed: the dev servers it
 * launched (with everything they spawned) and Playwright's browser.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const WINDOWS = process.platform === 'win32';
const INTERVAL_MS = WINDOWS ? 5000 : 1000;
/** Samples in a row the system must be out of memory before stopping: one bad moment isn't enough. */
const CRITICAL_SAMPLES = 3;
/** Below this, breakhound is too small a part of the problem for stopping it to help. */
const MEANINGFUL = 1 * GB;

export type MemoryLimit = string | false | undefined;

/**
 * The most memory breakhound's processes may use together: a size like
 * "6GB" or "4096MB", a share of the computer's memory like "50%", or false
 * for no limit. By default 60% of the memory, keeping at least 2 GB free.
 */
export function parseMemoryLimit(limit: MemoryLimit, total = totalmem()): number | null {
  if (limit === false) return null;
  if (limit === undefined || limit === '') {
    return Math.max(2 * GB, Math.min(total * 0.6, total - 2 * GB));
  }
  const text = String(limit).trim().toLowerCase();
  if (text === 'off' || text === 'none') return null;
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(%|gb|g|mb|m)$/);
  if (!m) {
    throw new Error(
      `memoryLimit must be a size like "6GB" or "4096MB", a share like "50%", or "off" (got "${limit}")`,
    );
  }
  const n = Number(m[1]);
  const bytes = m[2] === '%' ? (total * n) / 100 : n * (m[2]?.startsWith('g') ? GB : MB);
  if (!(bytes > 0)) throw new Error('memoryLimit must be more than 0');
  return bytes;
}

export function formatBytes(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

export interface Proc {
  pid: number;
  ppid: number;
  /** Process group; same as pid on Windows, which has none. */
  pgid: number;
  /** Resident memory in bytes. */
  rss: number;
  command: string;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: 16 * MB, timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      rss: Number(m[4]) * 1024,
      command: m[5] ?? '',
    });
  }
  return procs;
}

async function listProcesses(): Promise<Proc[] | null> {
  if (!WINDOWS) {
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,comm=']);
    return out === null ? null : parsePs(out);
  }
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.ProcessId) $([math]::Floor($_.WorkingSetSize / 1024)) $($_.Name)" }',
  ]);
  return out === null ? null : parsePs(out);
}

export function parseFootprint(out: string): Map<number, number> {
  const found = new Map<number, number>();
  for (const m of out.matchAll(/\[(\d+)\]:.*?Footprint:\s*(\d+) B/g)) {
    found.set(Number(m[1]), Number(m[2]));
  }
  return found;
}

/**
 * On macOS, resident memory leaves out what the system has compressed, and
 * under pressure that's most of it: a process holding 600 MB can show 30 MB.
 * The footprint (what Activity Monitor shows) counts it. Processes it can't
 * read are left out of the answer and keep their resident size.
 */
async function footprints(pids: number[]): Promise<Map<number, number>> {
  if (process.platform !== 'darwin' || !pids.length) return new Map();
  const out = await run('footprint', ['-f', 'bytes', ...pids.map(String)]);
  return out === null ? new Map() : parseFootprint(out);
}

/** How short the system is on memory, when the system says so: macOS's pressure level, Linux's available memory. */
async function systemCritical(): Promise<boolean> {
  if (process.platform === 'darwin') {
    // 1 is normal, 2 warn (common on 8 GB Macs and fine), 4 critical.
    const out = await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
    return Number(out?.trim()) >= 4;
  }
  if (process.platform === 'linux') {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const field = (name: string) =>
        Number(info.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1]);
      const total = field('MemTotal');
      const available = field('MemAvailable');
      return total > 0 && available >= 0 && available / total < 0.05;
    } catch {
      return false;
    }
  }
  return false;
}

const BROWSER = /chrom|headless_shell|playwright/i;

export interface Usage {
  total: number;
  devServer: number;
  browser: number;
  /** breakhound itself, and anything else it runs. */
  other: number;
  /** Processes that may be killed: the started dev servers and the browser. */
  killable: Proc[];
  /** Every process counted. */
  pids: number[];
}

/**
 * Memory used by `self` and everything it started, plus the process groups
 * of the dev servers in `servers` (they run in their own group, and their
 * children can outlive the shell that started them).
 */
export function measure(procs: Proc[], self: number, servers: Set<number>): Usage {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const subtree = (root: number): Set<number> => {
    const seen = new Set<number>([root]);
    const todo = [root];
    while (todo.length) {
      for (const c of children.get(todo.pop() as number) ?? []) {
        if (!seen.has(c.pid)) {
          seen.add(c.pid);
          todo.push(c.pid);
        }
      }
    }
    return seen;
  };
  const server = new Set<number>();
  for (const pid of servers) {
    for (const p of subtree(pid)) server.add(p);
    if (!WINDOWS) for (const p of procs) if (p.pgid === pid) server.add(p.pid);
  }
  for (const p of [...server]) for (const q of subtree(p)) server.add(q);
  const ours = subtree(self);
  for (const p of server) ours.add(p);

  const usage: Usage = { total: 0, devServer: 0, browser: 0, other: 0, killable: [], pids: [] };
  for (const p of procs) {
    if (!ours.has(p.pid)) continue;
    usage.pids.push(p.pid);
    usage.total += p.rss;
    if (server.has(p.pid)) {
      usage.devServer += p.rss;
      usage.killable.push(p);
    } else if (p.pid !== self && BROWSER.test(p.command)) {
      usage.browser += p.rss;
      usage.killable.push(p);
    } else {
      usage.other += p.rss;
    }
  }
  return usage;
}

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

function explain(usage: Usage, reason: string): string {
  const parts = [
    usage.devServer ? `the dev server ${formatBytes(usage.devServer)}` : '',
    usage.browser ? `the browser ${formatBytes(usage.browser)}` : '',
    usage.other ? `breakhound ${formatBytes(usage.other)}` : '',
  ].filter(Boolean);
  const advice =
    usage.devServer > usage.browser
      ? [
          'Most of it was the dev server. Start it yourself in another terminal and run breakhound again, so it only runs the browser,',
          'or scan fewer routes at a time (e.g. npx breakhound /pricing).',
        ]
      : ['Use fewer browser tabs at once (--concurrency 1), or scan fewer routes at a time.'];
  return [
    `Stopped to keep your computer responsive: ${reason}.`,
    parts.length ? `In use: ${parts.join(', ')}.` : '',
    'The dev server and browser breakhound started have been shut down.',
    ...advice,
    'To allow more, set memoryLimit in the config or pass --memory-limit (e.g. 8GB, 75%, or off).',
  ]
    .filter(Boolean)
    .join('\n');
}

function kill(procs: Proc[], servers: Set<number>): void {
  if (WINDOWS) {
    for (const pid of new Set([...servers, ...procs.map((p) => p.pid)])) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
    return;
  }
  for (const pid of servers) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const p of procs) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

interface Probe {
  processes(): Promise<Proc[] | null>;
  critical(): Promise<boolean>;
  /** Better sizes for some processes than ps gives, by pid. */
  footprints?(pids: number[]): Promise<Map<number, number>>;
}

const SYSTEM: Probe = { processes: listProcesses, critical: systemCritical, footprints };

/** What breakhound and the dev servers in `servers` use right now; null when it can't be read. */
export async function measureNow(
  servers: Set<number> = new Set(),
  probe: Probe = SYSTEM,
): Promise<Usage | null> {
  const procs = await probe.processes();
  if (!procs) return null;
  const usage = measure(procs, process.pid, servers);
  const better = await probe.footprints?.(usage.pids);
  if (!better?.size) return usage;
  return measure(
    procs.map((p) => ({ ...p, rss: better.get(p.pid) ?? p.rss })),
    process.pid,
    servers,
  );
}

export interface GuardOptions {
  limit: number | null;
  /** For tests: where process and system readings come from. */
  probe?: Probe;
  intervalMs?: number;
}

/**
 * One watcher for the whole process, running while any guarded work is.
 * Dev servers are registered as they start, so they're covered from their
 * very first second, including a slow first compile.
 */
class Guard {
  private servers = new Set<number>();
  private users = 0;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private criticalCount = 0;
  private limit: number | null = null;
  private probe: Probe = SYSTEM;
  private listeners = new Set<(error: MemoryError) => void>();
  /** Highest total seen, for tests and troubleshooting. */
  peak = 0;

  trackServer(pid: number | undefined): void {
    if (pid !== undefined) this.servers.add(pid);
  }

  untrackServer(pid: number | undefined): void {
    if (pid !== undefined) this.servers.delete(pid);
  }

  /** Runs `work` with the guard on. If it trips, `work` is abandoned and its error is the guard's. */
  async run<T>(options: GuardOptions, work: () => Promise<T>): Promise<T> {
    if (options.limit === null && !options.probe) return work();
    this.start(options);
    let onTrip: (error: MemoryError) => void = () => {};
    const tripped = new Promise<never>((_, reject) => {
      onTrip = reject;
      this.listeners.add(onTrip);
    });
    const task = work();
    // Once the guard has killed its processes, the work fails on its own; that error doesn't matter.
    task.catch(() => {});
    try {
      return await Promise.race([task, tripped]);
    } finally {
      this.listeners.delete(onTrip);
      this.stop();
    }
  }

  private start(options: GuardOptions): void {
    this.users++;
    // The strictest limit wins while several things run at once.
    if (options.limit !== null)
      this.limit = this.limit === null ? options.limit : Math.min(this.limit, options.limit);
    if (options.probe) this.probe = options.probe;
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), options.intervalMs ?? INTERVAL_MS);
    this.timer.unref();
  }

  private stop(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.limit = null;
    this.criticalCount = 0;
    this.probe = SYSTEM;
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [usage, critical] = await Promise.all([
        measureNow(this.servers, this.probe),
        this.probe.critical(),
      ]);
      if (!usage || !this.timer) return;
      this.peak = Math.max(this.peak, usage.total);
      this.criticalCount = critical ? this.criticalCount + 1 : 0;
      let reason: string | null = null;
      if (this.limit !== null && usage.total > this.limit) {
        reason = `breakhound and the processes it started were using ${formatBytes(usage.total)}, over the limit of ${formatBytes(this.limit)}`;
      } else if (this.criticalCount >= CRITICAL_SAMPLES && usage.total >= MEANINGFUL) {
        reason = `your computer was running out of memory, and breakhound's processes were using ${formatBytes(usage.total)} of it`;
      }
      if (!reason) return;
      kill(usage.killable, this.servers);
      this.servers.clear();
      this.criticalCount = 0;
      const error = new MemoryError(explain(usage, reason), usage);
      for (const listener of this.listeners) listener(error);
    } finally {
      this.sampling = false;
    }
  }
}

export const guard = new Guard();
