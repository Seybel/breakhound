import { styleText } from 'node:util';
import type { Scanner } from '@breakhound/engine';
import {
  detectProject,
  findRunningServer,
  globMatches,
  isReachable,
  type Project,
  parsePattern,
  type RoutePattern,
  type RouteSource,
  type RunningServer,
  readRuntimeRoutes,
  runtimeRoutes,
  startServer,
  staticRoutes,
  wantsRuntimeRoutes,
} from '@breakhound/routes';
import type { BreakhoundConfig } from './config';

export const DEFAULT_MAX_ROUTES = 100;
/** When nothing lists the routes, following links stops sooner. */
export const DEFAULT_MAX_CRAWL = 50;

/** Adds the app's base path, unless the server already printed it as part of its URL. */
function withBasePath(url: string, basePath: string): string {
  const clean = url.replace(/\/+$/, '');
  if (!basePath || new URL(clean).pathname.replace(/\/+$/, '') === basePath) return clean;
  return `${new URL(clean).origin}${basePath}`;
}

export interface AppServer {
  project: Project | null;
  baseUrl: string;
  server: RunningServer | null;
}

function log(quiet: boolean, line: string): void {
  if (!quiet) console.log(line);
}

/** Where the app is: the configured URL, a dev server that's already running, or one we start. */
export async function resolveServer(
  cwd: string,
  config: BreakhoundConfig,
  quiet: boolean,
): Promise<AppServer> {
  const project = detectProject(cwd);
  const name = project?.framework.id !== 'unknown' ? project?.framework.name : null;
  // A local URL the user asked for, kept once the server is up (some apps behave differently on 127.0.0.1).
  let wanted: string | null = null;
  if (config.baseUrl) {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(baseUrl);
    // A local URL that nothing answers on yet: start the dev server, like with no URL at all.
    if (!local || !project?.devScript || (await isReachable(baseUrl))) {
      return { project, baseUrl, server: null };
    }
    const port = Number(new URL(baseUrl).port) || undefined;
    wanted = baseUrl;
    config = {
      ...config,
      baseUrl: undefined,
      server: { ...(port ? { port } : {}), ...config.server },
    };
  }
  if (!project) {
    throw new Error(
      'No package.json here, so there is no app to find. Run breakhound in your project folder, or pass a URL: npx breakhound http://localhost:3000',
    );
  }
  if (config.server?.port) {
    project.ports = [config.server.port, ...project.ports.filter((p) => p !== config.server?.port)];
  }
  const running = config.server?.command ? null : await findRunningServer(project);
  if (running) {
    const baseUrl = withBasePath(running.url, project.basePath);
    log(quiet, `${styleText('green', '✔')} ${name ?? 'App'} running at ${baseUrl}`);
    return { project, baseUrl, server: null };
  }
  const command = config.server?.command;
  const label =
    command ?? (project.devScript ? `${project.packageManager} run ${project.devScript.name}` : '');
  log(quiet, styleText('dim', `Starting ${name ?? 'the app'} with ${label}...`));
  const server = await startServer(project, {
    ...(command ? { command } : {}),
    ...(config.server?.port ? { port: config.server.port } : {}),
    ...(config.server?.timeout ? { timeoutMs: config.server.timeout * 1000 } : {}),
  });
  const baseUrl =
    wanted && (await isReachable(wanted)) ? wanted : withBasePath(server.url, project.basePath);
  log(quiet, `${styleText('green', '✔')} ${name ?? 'App'} started at ${baseUrl}`);
  return { project, baseUrl, server };
}

export interface RoutePlan {
  /** Where the routes came from; null when following links. */
  from: string | null;
  patterns: RoutePattern[];
  /** No route list was found, so links are followed from the home page. */
  crawl: boolean;
  /** React apps can render more routes on deeper pages, so the router is read on every page. */
  readRouterOnEveryPage: boolean;
  /** Routes left out by include, exclude or maxRoutes. */
  filtered: number;
}

function merge(...sources: (RouteSource | null)[]): RouteSource | null {
  const present = sources.filter((s): s is RouteSource => Boolean(s?.routes.length));
  if (!present.length) return null;
  const routes = new Map<string, RoutePattern>();
  for (const s of present) for (const r of s.routes) if (!routes.has(r.path)) routes.set(r.path, r);
  return { from: present.map((s) => s.from).join(' and '), routes: [...routes.values()] };
}

export function applyFilters(
  patterns: RoutePattern[],
  config: BreakhoundConfig,
  max: number,
): { kept: RoutePattern[]; filtered: number } {
  const included = patterns.filter(
    (p) =>
      (!config.include?.length || config.include.some((g) => globMatches(g, p.path))) &&
      !config.exclude?.some((g) => globMatches(g, p.path)),
  );
  const kept = included.slice(0, max);
  return { kept, filtered: patterns.length - kept.length };
}

/** Route patterns for the app, from config, source files, or the live router. */
export async function planRoutes(
  app: AppServer,
  config: BreakhoundConfig,
  scanner: Scanner,
  explicit: string[],
): Promise<RoutePlan> {
  const max = config.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const listed = explicit.length ? explicit : config.routes;
  if (listed?.length) {
    const patterns = listed.map((r) => parsePattern(r.startsWith('/') ? r : `/${r}`));
    return { from: null, patterns, crawl: false, readRouterOnEveryPage: false, filtered: 0 };
  }

  const project = app.project;
  const framework = project?.framework.id ?? 'unknown';
  const fromFiles = project ? staticRoutes(project) : null;
  let fromRuntime: RouteSource | null = null;
  if (wantsRuntimeRoutes(framework)) {
    fromRuntime = await scanner
      .visit(`${app.baseUrl}/`, (page) => page.evaluate(readRuntimeRoutes))
      .then(runtimeRoutes)
      .catch(() => null);
  }

  // The live router knows about routes added by plugins and modules, so it wins when it answers.
  // Remix, React Router 7 and TanStack can load routes lazily, so their files are added too.
  const lazyRouters = ['remix', 'react-router', 'tanstack'];
  const source = fromRuntime
    ? lazyRouters.includes(framework)
      ? merge(fromRuntime, fromFiles)
      : fromRuntime
    : fromFiles;

  if (!source) {
    const { kept } = applyFilters([parsePattern('/')], config, max);
    return { from: null, patterns: kept, crawl: true, readRouterOnEveryPage: false, filtered: 0 };
  }
  const { kept, filtered } = applyFilters(source.routes, config, max);
  return {
    from: source.from,
    patterns: kept,
    crawl: false,
    readRouterOnEveryPage: fromRuntime?.from === 'the React Router tree',
    filtered,
  };
}
