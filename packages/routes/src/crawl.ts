/**
 * Route finding that runs anywhere, the browser included: links worth
 * following, which route a link belongs to, and routes read from a live router.
 */
import { matchesPattern, type RoutePattern, specificity } from './pattern';
import type { RuntimeRoutes } from './runtime';
import { fromReactRouterPath, fromTanstackPath, fromVueRouterPath } from './syntax';

export interface RouteSource {
  /** Where the routes came from, for the CLI to show, e.g. "src/app" or "the Vue router". */
  from: string;
  routes: RoutePattern[];
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
