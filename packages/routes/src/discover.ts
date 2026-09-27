import { routeConfigRoutes, sourceRoutes } from './ast';
import { fileRoutes } from './files';
import { matchesPattern, type RoutePattern, specificity } from './pattern';
import type { FrameworkId, Project } from './project';
import type { RuntimeRoutes } from './runtime';
import { fromReactRouterPath, fromTanstackPath, fromVueRouterPath } from './syntax';

export interface RouteSource {
  /** Where the routes came from, for the CLI to show, e.g. "src/app" or "the Vue router". */
  from: string;
  routes: RoutePattern[];
}

/** Frameworks whose route list lives entirely in files; no need to ask the running app. */
const FILES_ONLY: FrameworkId[] = ['next', 'sveltekit', 'astro'];

/** Whether it's worth reading the live router before scanning. */
export function wantsRuntimeRoutes(framework: FrameworkId): boolean {
  return !FILES_ONLY.includes(framework);
}

/** Routes read from the project without running it: route files, route config, or router code. */
export function staticRoutes(project: Project): RouteSource | null {
  const { root, framework } = project;
  if (framework.id === 'react-router' || framework.id === 'remix') {
    const config = routeConfigRoutes(root);
    if (config?.length) return { from: 'app/routes.ts', routes: config };
  }
  const files = fileRoutes(root, framework.id);
  if (files?.routes.length) return files;
  if (framework.id === 'react' || framework.id === 'vue') {
    const code = sourceRoutes(root, framework.id);
    if (code.routes.length) return { from: 'your router code', routes: code.routes };
  }
  return null;
}

const RUNTIME_NAMES = {
  vue: 'the Vue router',
  'react-router': 'the React Router tree',
  remix: 'the route manifest',
  tanstack: 'the TanStack router',
} as const;

/** Converts what the live router reported into patterns. */
export function runtimeRoutes(found: RuntimeRoutes): RouteSource | null {
  if (!found.router || !found.paths.length) return null;
  const convert =
    found.router === 'vue'
      ? fromVueRouterPath
      : found.router === 'tanstack'
        ? fromTanstackPath
        : fromReactRouterPath;
  const routes = new Map<string, RoutePattern>();
  for (const p of found.paths) {
    const pattern = convert(p);
    if (pattern && !routes.has(pattern.path)) routes.set(pattern.path, pattern);
  }
  return routes.size ? { from: RUNTIME_NAMES[found.router], routes: [...routes.values()] } : null;
}

/**
 * The route a URL path belongs to: the most specific pattern that matches it,
 * so `/blog/new` goes to a `/blog/new` page before `/blog/[slug]`.
 */
export function routeFor(pathname: string, patterns: Iterable<RoutePattern>): RoutePattern | null {
  let best: RoutePattern | null = null;
  for (const p of patterns) {
    if (matchesPattern(p, pathname) && (!best || specificity(p) > specificity(best))) best = p;
  }
  return best;
}

/** Links that are files, or that would change state if followed. */
const NOT_A_PAGE =
  /\.(pdf|zip|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|xml|txt|json|css|js|mjs|map|csv|xlsx?|docx?)$/i;
const UNSAFE =
  /(^|\/)(log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe)(\/|$)|^\/api\//i;

export function isCrawlable(pathname: string): boolean {
  return !NOT_A_PAGE.test(pathname) && !UNSAFE.test(pathname);
}

/**
 * Following links when nothing else lists the routes. Pages under the same
 * parent (/blog/a, /blog/b, ...) usually share a layout, so only a few of
 * them are taken.
 */
export class Crawler {
  private readonly taken = new Set<string>();
  private readonly perParent = new Map<string, number>();

  constructor(
    private readonly limit: number,
    /** Pages the user wants scanned (include and exclude). */
    private readonly wanted: (path: string) => boolean = () => true,
    private readonly perParentLimit = 3,
  ) {}

  get count(): number {
    return this.taken.size;
  }

  /** Marks a path as already planned. */
  claim(pathname: string): void {
    this.taken.add(normalize(pathname));
  }

  /** The links worth visiting, in order. */
  add(links: string[]): string[] {
    const out: string[] = [];
    for (const raw of links) {
      const path = normalize(raw);
      if (this.taken.has(path) || !isCrawlable(path) || !this.wanted(path)) continue;
      if (this.taken.size >= this.limit) continue;
      const parent = path.replace(/\/[^/]*$/, '') || '/';
      const n = this.perParent.get(parent) ?? 0;
      // Top-level pages are all different; deeper siblings are usually the same template.
      if (parent !== '/' && n >= this.perParentLimit) continue;
      this.perParent.set(parent, n + 1);
      this.taken.add(path);
      out.push(path);
    }
    return out;
  }
}

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}
