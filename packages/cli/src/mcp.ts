import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { RouteResult, ScanResult, Severity } from '@breakhound/engine';
import { formatRanges, groupIssues, renderIssue, sourceText } from '@breakhound/report';
import { isReachable } from '@breakhound/routes';
import { type AppServer, resolveServer } from './app';
import { type Bridge, NoPanelError, startBridge } from './bridge';
import { type BreakhoundConfig, loadConfig } from './config';
import { guard, MemoryError, parseMemoryLimit } from './guard';
import { ICON_PNG } from './icon';
import { readLastResult, runScan } from './scan';
import { checkpoint, listCheckpoints, undo } from './session';
import { formatVerify, readBaseline, runVerify, severitiesAtOrAbove, verifyPassed } from './verify';

/**
 * breakhound as an MCP server, over stdio. It speaks the small part of the
 * protocol tools need (initialize, tools/list, tools/call, ping, progress)
 * directly, so `npx @seybel/breakhound` stays quick to install. The dev server it
 * finds or starts stays up between calls, so verify runs don't wait for it.
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `breakhound finds responsive layout bugs by resizing pages in a real browser, and tells you the exact widths where they happen.

How to fix issues with it:
1. list_issues first: the developer may have scanned in the breakhound browser extension and sent the issues here, and then they are ready. Otherwise scan (once) to find every route and its issues. Either becomes the baseline.
2. get_issue for the details of an issue: widths, element, source file, measurements, a likely fix and a screenshot.
3. Edit the code. Fix the cause (styles, markup, component), don't hide it with overflow: hidden, and keep other widths as they were.
4. verify the routes you touched. It compares with the baseline: fixed, still there, and new. New issues mean the change broke something, often at another width or on another page; fix those too.
5. When verify is clean for a route, checkpoint it. That commits the fix on its own, so it can be undone later with undo.
Before finishing, run verify with no routes to check every page.

Issues sent from the extension are checked again in the developer's own browser: verify asks the open breakhound panel to scan the pages, so their login and browser carry over. If no panel is open, verify says so; ask the developer to open it rather than calling scan, which replaces their issues with a headless scan.`;

/** Offered to clients as a ready-made prompt (a slash command in Claude Code). */
const FIX_PROMPT = `Fix the responsive layout issues breakhound found in this project.

Start with list_issues: if I sent them from the breakhound extension they are already there, so don't scan again. Only scan when there are none.
Work through the errors first, then the warnings. For each one: get_issue for the details, fix the cause in the code (not overflow: hidden), verify the routes you touched, and checkpoint each route once verify is clean for it.
Before you finish, verify with no routes to check every page, and tell me what you fixed and anything you couldn't.`;

interface Json {
  [key: string]: unknown;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run(args: Json, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
}

interface ToolContext {
  root: string;
  config: BreakhoundConfig;
  /** Where the browser extension connects, when it could start. */
  bridge: Bridge | null;
  progress(done: number, message: string): void;
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError } : {}),
});

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

const routesProperty = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

function issueList(
  result: ScanResult,
  filter: { route?: string; severity?: Severity } = {},
): string[] {
  const lines: string[] = [];
  for (const g of groupIssues(result)) {
    if (filter.severity && g.issue.severity !== filter.severity) continue;
    if (filter.route && !g.routes.some((r) => r.route.route === filter.route)) continue;
    const pages = g.routes.map((r) => r.route.route).join(', ');
    const source = sourceText(g.issue.element.source);
    lines.push(
      `- ${g.issue.id} [${g.issue.severity}] ${formatRanges(g.issue.ranges)}: ${g.issue.title} · \`${g.issue.element.selector}\`${source ? ` · ${source}` : ''} · on ${pages}`,
    );
  }
  return lines;
}

function pageLine(r: RouteResult): string {
  const where = r.url ? ` (${r.url})` : '';
  if (r.status === 'scanned')
    return `- ${r.route}${where}: ${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}`;
  return `- ${r.route}${where}: ${r.status}${r.error ? `, ${r.error}` : ''}`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function scanSummary(result: ScanResult): string {
  const scanned = result.routes.filter((r) => r.status === 'scanned');
  const { bySeverity } = result.summary;
  const issues = issueList(result);
  const lines = [
    `Scanned ${scanned.length} of ${result.routes.length} routes from ${result.settings.minWidth} to ${result.settings.maxWidth}px: ${count(bySeverity.error, 'error')}, ${count(bySeverity.warning, 'warning')}, ${bySeverity.info} info.`,
  ];
  const other = result.routes.filter((r) => r.status !== 'scanned');
  if (other.length) {
    lines.push('', 'Not scanned:', ...other.map(pageLine));
    if (other.some((r) => r.status === 'login')) {
      lines.push(
        'Pages behind a login need a saved session: ask the user to run `npx @seybel/breakhound login` once.',
      );
    }
  }
  lines.push(
    '',
    issues.length
      ? 'Issues (id, severity, widths, title, element, source, pages):'
      : 'No issues found.',
  );
  lines.push(...issues);
  if (issues.length) lines.push('', 'Next: get_issue for details, fix, then verify.');
  return lines.join('\n');
}

export function createTools(): Tool[] {
  return [
    {
      name: 'scan',
      description:
        'Find the app (starting its dev server if needed), discover its routes and scan each one at every width from 320 to 1920px in a headless browser. Returns every issue with its id. The result is the baseline that verify compares with, replacing any issues the developer sent from the browser extension, so check list_issues first. Takes from seconds to a few minutes on large apps.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: routesProperty(
            'Only these routes, e.g. ["/pricing", "/blog/**"]. Leave out to scan the whole app.',
          ),
        },
      },
      async run(args, ctx) {
        const routes = strings(args.routes);
        const globs = routes.filter((r) => r.includes('*'));
        let done = 0;
        const { result } = await runScan({
          targets: routes.filter((r) => !r.includes('*')),
          config: globs.length ? { ...ctx.config, include: globs } : ctx.config,
          cwd: ctx.root,
          version: VERSION,
          quiet: true,
          app: await server.get(ctx),
          onPage: (r) => ctx.progress(++done, `Scanned ${r.route}`),
        });
        return text(scanSummary(result));
      },
    },
    {
      name: 'list_routes',
      description: 'Routes from the last scan, with their status and number of issues.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, ctx) {
        const { result } = readLastResult(ctx.root, ctx.config.outDir);
        return text(result.routes.map(pageLine).join('\n') || 'No routes.');
      },
    },
    {
      name: 'list_issues',
      description:
        'Issues from the last scan or verify, each listed once even when it shows up on several routes. Filter by route or severity.',
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Only issues on this route, e.g. /pricing.' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        },
      },
      async run(args, ctx) {
        const { result } = readLastResult(ctx.root, ctx.config.outDir);
        const lines = issueList(result, {
          ...(typeof args.route === 'string' ? { route: args.route } : {}),
          ...(typeof args.severity === 'string' ? { severity: args.severity as Severity } : {}),
        });
        return text(lines.length ? lines.join('\n') : 'No issues match.');
      },
    },
    {
      name: 'get_issue',
      description:
        'Everything about one issue: the widths, the element and where it is in the code (when known), measurements, computed styles, a likely fix, every page it is on, and a screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Issue id from scan, list_issues or verify.' },
        },
        required: ['id'],
      },
      async run(args, ctx) {
        const { result, dir } = readLastResult(ctx.root, ctx.config.outDir);
        const found = renderIssue(result, String(args.id ?? ''));
        if (!found)
          return text(
            `No issue with id ${String(args.id)}. list_issues shows the current ones.`,
            true,
          );
        const out: ToolResult = { content: [{ type: 'text', text: found.text }] };
        const shot = found.issue.screenshot && join(dir, 'screenshots', found.issue.screenshot);
        if (shot && existsSync(shot)) {
          out.content.push({
            type: 'image',
            data: readFileSync(shot).toString('base64'),
            mimeType: 'image/png',
          });
        }
        return out;
      },
    },
    {
      name: 'verify',
      description:
        'Scan routes again and compare with the baseline from scan: which issues are fixed, which are still there, and which are new (a change broke something, maybe at another width or on another route). Pass the routes you changed for a quick check, and nothing to check every route before you finish.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: routesProperty(
            'Routes to check, e.g. ["/pricing"]. Leave out to check every scanned route.',
          ),
        },
      },
      async run(args, ctx) {
        let done = 0;
        const baseline = readBaseline(ctx.root, ctx.config.outDir);
        const inBrowser = baseline.from === 'extension';
        const bridge = ctx.bridge;
        if (inBrowser && !bridge) {
          return text(
            "These issues were sent from the breakhound extension, but this server couldn't open the port the extension connects on. Call scan to check the app in a headless browser instead.",
            true,
          );
        }
        const origin = inBrowser ? new URL(baseline.project.baseUrl ?? '').origin : '';
        let v: Awaited<ReturnType<typeof runVerify>>;
        try {
          v = await runVerify({
            cwd: ctx.root,
            config: ctx.config,
            version: VERSION,
            quiet: true,
            routes: strings(args.routes),
            ...(inBrowser && bridge
              ? {
                  scanPages: (pages, widths) => {
                    ctx.progress(0, 'Checking in the breakhound panel in your browser');
                    return bridge.scanInBrowser(pages, widths, origin, ctx.progress);
                  },
                }
              : {
                  app: await server.get(ctx),
                  onPage: (r) => ctx.progress(++done, `Checked ${r.route}`),
                }),
          });
        } catch (error) {
          if (error instanceof NoPanelError) return text(error.message, true);
          throw error;
        }
        const severities = severitiesAtOrAbove('warning');
        return text(
          formatVerify(v, severities) +
            (verifyPassed(v, severities) ? '\nYou can checkpoint these routes now.' : ''),
        );
      },
    },
    {
      name: 'checkpoint',
      description:
        'Commit the current changes as the fix for some routes (a normal git commit, tagged with the routes), so they can be undone on their own later. Call it once verify is clean for those routes. Changes the user made before the scan are never included; it stops and says so instead.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: routesProperty('Routes these changes fix, e.g. ["/pricing"].'),
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              "The files you changed for this fix, from the project folder. Recommended: only these are committed, so the user's own unsaved work never ends up in it. Every changed file when left out.",
          },
          message: {
            type: 'string',
            description: 'Commit subject. Defaults to "Fix responsive layout on <routes>".',
          },
        },
        required: ['routes'],
      },
      async run(args, ctx) {
        const routes = strings(args.routes);
        const details = fixedDetails(ctx, routes);
        const files = strings(args.files);
        const c = checkpoint(ctx.root, {
          routes,
          ...(files.length ? { files } : {}),
          ...(typeof args.message === 'string' ? { message: args.message } : {}),
          details,
          ...(ctx.config.outDir ? { outDir: ctx.config.outDir } : {}),
        });
        return text(
          `Committed ${c.hash}: ${c.subject}\nUndo it any time with undo for ${c.routes.join(', ')}.`,
        );
      },
    },
    {
      name: 'undo',
      description:
        'Revert the checkpointed fixes for some routes, or for the whole session, with a new commit. With no arguments it lists the fixes that can be undone. It refuses to run while there are uncommitted changes.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: routesProperty('Routes whose fixes to undo, e.g. ["/pricing"].'),
          session: { type: 'boolean', description: 'Undo every fix from this session.' },
        },
      },
      async run(args, ctx) {
        const routes = strings(args.routes);
        if (!routes.length && args.session !== true) {
          const list = listCheckpoints(ctx.root);
          return text(
            list.length
              ? `Fixes you can undo:\n${list.map((c) => `- ${c.hash.slice(0, 10)} ${c.routes.join(', ')}: ${c.subject}`).join('\n')}`
              : 'There are no breakhound fixes on this branch.',
          );
        }
        const r = undo(ctx.root, {
          ...(routes.length ? { routes } : {}),
          session: args.session === true,
          ...(ctx.config.outDir ? { outDir: ctx.config.outDir } : {}),
        });
        const also = r.alsoUndone.length
          ? `\nThis also undid ${r.alsoUndone.join(', ')}, fixed in the same commit.`
          : '';
        return text(
          `Undid ${r.undone.length} fix${r.undone.length === 1 ? '' : 'es'} in commit ${r.hash}.${also}\nRun verify to see the issues back.`,
        );
      },
    },
  ];
}

/** Lines for the commit body: the issues the last verify saw fixed on these routes. */
function fixedDetails(ctx: ToolContext, routes: string[]): string[] {
  const file = join(resolve(ctx.root, ctx.config.outDir ?? '.breakhound'), 'verify.json');
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as {
      fixed: { route: string; issue: { title: string; ranges: { from: number; to: number }[] } }[];
    };
    return v.fixed
      .filter((c) => routes.includes(c.route))
      .map((c) => `- ${c.route} ${formatRanges(c.issue.ranges)}: ${c.issue.title}`);
  } catch {
    return [];
  }
}

let VERSION = '0.0.0';

/** The app server, found or started once and kept for the whole MCP session. */
const server = {
  current: null as AppServer | null,
  async get(ctx: ToolContext): Promise<AppServer> {
    const current = this.current;
    if (current) {
      if (await isReachable(current.baseUrl)) return current;
      await current.server?.stop();
      this.current = null;
    }
    this.current = await resolveServer(ctx.root, ctx.config, true);
    return this.current;
  },
  async stop(): Promise<void> {
    await this.current?.server?.stop();
    this.current = null;
  },
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export interface McpIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export async function runMcpServer(
  version: string,
  io: McpIo = { input: process.stdin, output: process.stdout },
): Promise<void> {
  VERSION = version;
  if (io.output === process.stdout) {
    // stdout carries the protocol: anything else printed there would break it.
    console.log = console.error;
    console.info = console.error;
  }

  const tools = createTools();
  let bridge: Bridge | null = null;
  let bridging: Promise<void> | null = null;
  /** Once the client is ready: the extension can find this project from then on. */
  const openBridge = () => {
    if (bridging || process.env.BREAKHOUND_NO_BRIDGE) return;
    bridging = (async () => {
      const dir = await projectRoot();
      bridge = await startBridge({
        root: dir,
        version: VERSION,
        loadConfig: async () => (await loadConfig(dir)).config,
      }).catch(() => null);
      if (!bridge)
        console.error('breakhound: the browser extension has no free port to connect on.');
    })();
  };
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let clientCanListRoots = false;
  let root: string | null = process.env.BREAKHOUND_ROOT ?? null;
  // One tool at a time: two scans at once would fight over the same files.
  let queue: Promise<unknown> = Promise.resolve();

  const send = (message: Json) =>
    io.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method: string, params: Json = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id: `bh-${id}`, method, params });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 5000).unref();
    });

  /** The project: BREAKHOUND_ROOT, else the working directory, else the client's first workspace folder. */
  async function projectRoot(): Promise<string> {
    if (root) return root;
    const cwd = process.cwd();
    const looksLikeProject = [
      'package.json',
      'breakhound.config.json',
      'breakhound.config.ts',
    ].some((f) => existsSync(join(cwd, f)));
    if (!looksLikeProject && clientCanListRoots) {
      try {
        const res = (await request('roots/list')) as { roots?: { uri: string }[] };
        const first = res.roots?.find((r) => r.uri.startsWith('file:'));
        if (first) root = fileURLToPath(first.uri);
      } catch {
        // Fall back to the working directory.
      }
    }
    root ??= cwd;
    return root;
  }

  async function callTool(id: unknown, params: Json): Promise<void> {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) {
      send({ id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
      return;
    }
    const token = (params._meta as Json | undefined)?.progressToken;
    try {
      const dir = await projectRoot();
      const { config, warnings } = await loadConfig(dir);
      // Starting the dev server happens here, outside the scan, so the whole call is guarded.
      const limit = parseMemoryLimit(config.memoryLimit);
      const result = await guard.run({ limit }, () =>
        tool.run((params.arguments as Json) ?? {}, {
          root: dir,
          config,
          bridge,
          progress(done, message) {
            if (token !== undefined)
              send({
                method: 'notifications/progress',
                params: { progressToken: token, progress: done, message },
              });
          },
        }),
      );
      if (warnings.length)
        result.content.push({ type: 'text', text: `Config warnings: ${warnings.join(' ')}` });
      send({ id, result });
    } catch (error) {
      // The guard shut the dev server down; the next call starts it again.
      if (error instanceof MemoryError) server.current = null;
      send({ id, result: text(error instanceof Error ? error.message : String(error), true) });
    }
  }

  function handle(message: Json): void {
    const { id, method } = message;
    const params = (message.params as Json | undefined) ?? {};
    // A response to one of our own requests.
    if (method === undefined && typeof id === 'string' && id.startsWith('bh-')) {
      const waiting = pending.get(Number(id.slice(3)));
      if (!waiting) return;
      pending.delete(Number(id.slice(3)));
      if (message.error) waiting.reject(new Error(String((message.error as Json).message)));
      else waiting.resolve(message.result);
      return;
    }
    if (id === undefined) {
      // Notifications need no answer.
      if (method === 'notifications/initialized') openBridge();
      return;
    }
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        clientCanListRoots = Boolean((params.capabilities as Json | undefined)?.roots);
        send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: {
              name: 'breakhound',
              version: VERSION,
              // Shown beside the server by clients that show icons. No sizes: some clients' older
              // schemas expect another shape for it, and an icon isn't worth a failed connection.
              icons: [{ src: ICON_PNG, mimeType: 'image/png' }],
            },
            instructions: INSTRUCTIONS,
          },
        });
        return;
      }
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({
          id,
          result: {
            tools: tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        });
        return;
      case 'prompts/list':
        send({
          id,
          result: {
            prompts: [
              {
                name: 'fix',
                description:
                  'Fix the responsive issues breakhound found, verifying and checkpointing each one',
              },
            ],
          },
        });
        return;
      case 'prompts/get':
        if (params.name !== 'fix') {
          send({ id, error: { code: -32602, message: `Unknown prompt: ${String(params.name)}` } });
          return;
        }
        send({
          id,
          result: {
            description: 'Fix the responsive issues breakhound found',
            messages: [{ role: 'user', content: { type: 'text', text: FIX_PROMPT } }],
          },
        });
        return;
      case 'tools/call':
        queue = queue.then(() => callTool(id, params));
        return;
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
    }
  }

  const lines = createInterface({ input: io.input });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(message);
  });
  await new Promise<void>((done) => lines.once('close', done));
  // The client went away: finish what's running, then stop the dev server we started.
  await bridging;
  await (bridge as Bridge | null)?.close();
  await queue;
  await server.stop();
}
