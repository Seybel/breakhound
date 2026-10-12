import { BRIDGE_PORTS, type RouteResult, type ScanResult } from '@breakhound/engine/core';

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
  return call(server.port, 'scan', { result }, { timeoutMs: 30_000 });
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
  return call(server.port, 'checks/done', { id, ...outcome }, { timeoutMs: 30_000 });
}
