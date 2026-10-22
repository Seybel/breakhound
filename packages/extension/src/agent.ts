import {
  BRIDGE_PORTS,
  DETECTOR_IDS,
  type Issue,
  type RouteResult,
  type ScanResult,
} from '@breakhound/engine/core';

/**
 * Talks to `breakhound mcp`, which a coding agent starts in a project: the panel sends it a scan
 * to fix, and it asks the panel to check the agent's fixes in this browser.
 */

/** One project with an agent connected, from what its breakhound server says about itself. */
export interface AgentServer {
  port: number;
  root: string;
  project: string;
  version: string;
  /** The checks it knows; one from before 1.0.10 doesn't say. */
  detectors?: string[];
}

/** What a breakhound from before 1.0.10 knows: every check but the calendar. */
const BEFORE_CALENDAR = DETECTOR_IDS.filter((id) => id !== 'calendar');

/**
 * The issue as a project's breakhound can take it. The extension updates by itself and the
 * project's breakhound may not have yet, so a check it doesn't know goes as one it does: a
 * calendar as the check that found the most inside it, keeping its title and fix.
 */
export function forServer(issue: Issue, known: readonly string[]): Issue | null {
  if (known.includes(issue.detector)) return issue;
  const inside = String(issue.evidence.checksInside ?? '')
    .split(' ')
    .map((part) => part.split(':')[0] ?? '')
    .find((id) => known.includes(id));
  return inside ? { ...issue, detector: inside as Issue['detector'] } : null;
}

/** Pages to scan again for the agent, at the widths they were scanned at first. */
export interface Check {
  id: string;
  pages: { route: string; url: string }[];
  widths: { minWidth: number; maxWidth: number };
}

async function call<T>(
  port: number,
  path: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 5000)];
  if (options.signal) signals.push(options.signal);
  const res = await fetch(`http://127.0.0.1:${port}/breakhound/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  const reply = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(reply.error ?? `breakhound answered ${res.status}`);
  return reply;
}

/** Every project on this machine whose agent has breakhound running. */
export async function findServers(): Promise<AgentServer[]> {
  const found = await Promise.all(
    BRIDGE_PORTS.map(async (port) => {
      try {
        const hello = await call<Omit<AgentServer, 'port'> & { name?: string }>(
          port,
          'hello',
          {},
          { timeoutMs: 1500 },
        );
        return hello.name === 'breakhound' ? { ...hello, port } : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((s): s is AgentServer => s !== null);
}

/** One server per project: two agents open in the same project share its breakhound folder. */
export function byProject(servers: AgentServer[]): AgentServer[] {
  const seen = new Map<string, AgentServer>();
  for (const s of servers) if (!seen.has(s.root)) seen.set(s.root, s);
  return [...seen.values()];
}

/** The servers whose project is the app this page belongs to. */
export async function serving(servers: AgentServer[], url: string): Promise<AgentServer[]> {
  const answers = await Promise.all(
    servers.map((s) =>
      call<{ matches: boolean }>(s.port, 'match', { url }, { timeoutMs: 4000 })
        .then((r) => r.matches)
        .catch(() => false),
    ),
  );
  return servers.filter((_, i) => answers[i]);
}

export function sendScan(
  server: AgentServer,
  result: ScanResult,
): Promise<{ routes: number; issues: number }> {
  const routes = knownTo(server, result.routes);
  return call(server.port, 'scan', { result: { ...result, routes } }, { timeoutMs: 30_000 });
}

function knownTo(server: AgentServer, routes: RouteResult[]): RouteResult[] {
  const known = server.detectors ?? BEFORE_CALENDAR;
  return routes.map((r) => ({
    ...r,
    issues: r.issues.map((i) => forServer(i, known)).filter((i): i is Issue => i !== null),
  }));
}

/** Waits a while for the agent to ask for a check on this site; null when it didn't. */
export async function nextCheck(
  server: AgentServer,
  origin: string,
  signal: AbortSignal,
): Promise<Check | null> {
  const reply = await call<{ check: Check | null }>(
    server.port,
    'checks',
    { origin },
    { timeoutMs: 35_000, signal },
  );
  return reply.check;
}

export function checkProgress(
  server: AgentServer,
  id: string,
  done: number,
  message: string,
): void {
  call(server.port, 'checks/progress', { id, done, message }).catch(() => {});
}

export function checkDone(
  server: AgentServer,
  id: string,
  outcome: { routes: RouteResult[] } | { error: string },
): Promise<unknown> {
  const sent = 'routes' in outcome ? { routes: knownTo(server, outcome.routes) } : outcome;
  return call(server.port, 'checks/done', { id, ...sent }, { timeoutMs: 30_000 });
}
