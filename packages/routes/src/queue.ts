import { type Crawler, isCrawlable, routeFor } from './crawl';
import { type RoutePattern, staticUrlPath } from './pattern';

/** A page to scan: its URL, and the route it stands for (`/blog/[slug]` for `/blog/hello`). */
export interface Target {
  url: string;
  route: string;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export interface Job extends Target {
  order: number;
  /** Only visited to find links, because include or exclude leaves the page itself out. */
  linksOnly?: boolean;
}

/**
 * The routes still to scan. In a whole-app scan it keeps growing: links on
 * scanned pages give dynamic routes a real URL, and (when following links)
 * add new pages.
 */
export class RouteQueue {
  readonly jobs: Job[] = [];
  /** App paths already scanned or planned, so redirects to them aren't scanned twice. */
  private readonly planned = new Set<string>();
  /** Dynamic routes still waiting for a link that fits them. */
  readonly waiting = new Map<string, RoutePattern>();
  readonly patterns = new Map<string, RoutePattern>();
  private order = 0;
  /** Where the app is mounted on its server, e.g. "/docs"; "" at the root. */
  private readonly basePath: string;

  constructor(
    private readonly baseUrl: string | null,
    private readonly samples: Record<string, string>,
    readonly crawler: Crawler | null,
    /** The app routes by hash, so its paths live after `/#`. */
    private readonly hashRouting = false,
  ) {
    this.basePath = baseUrl ? new URL(baseUrl).pathname.replace(/\/+$/, '') : '';
  }

  /** The full URL for an app path (or a full URL, as given). */
  private urlFor(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.baseUrl ?? '').replace(/\/+$/, '');
    const clean = path.startsWith('/') ? path : `/${path}`;
    return this.hashRouting && !clean.includes('#') ? `${base}/#${clean}` : `${base}${clean}`;
  }

  /** The app path for a path on the server, or null when it's outside the app. */
  private appPath(pathname: string): string | null {
    const path = trimSlash(pathname);
    if (!this.basePath) return path;
    if (path === this.basePath) return '/';
    return path.startsWith(`${this.basePath}/`) ? path.slice(this.basePath.length) : null;
  }

  /** The key a full URL is planned under: its app path, with the hash route when there is one. */
  private keyOf(url: string): string {
    const u = new URL(url);
    const path = this.appPath(u.pathname) ?? trimSlash(u.pathname);
    if (!u.hash.startsWith('#/')) return path;
    const hash = trimSlash(u.hash.slice(1).split('?')[0] as string);
    if (this.hashRouting) return hash;
    return `${path === '/' ? '' : path}/#${hash}`;
  }

  /** The app path a link from a page points at, or null when it's outside the app. */
  private linkPath(link: string): string | null {
    const [pathname = '/', hash] = link.split('#');
    if (this.hashRouting) return hash?.startsWith('/') ? trimSlash(hash) : null;
    return hash === undefined ? this.appPath(pathname) : null;
  }

  add(target: Target, linksOnly = false): void {
    const key = target.url.startsWith('http') ? this.keyOf(target.url) : target.url;
    if (this.planned.has(key)) return;
    this.planned.add(key);
    this.crawler?.claim(key);
    this.jobs.push({ ...target, order: this.order++, ...(linksOnly ? { linksOnly } : {}) });
  }

  /** The home page when following links but include or exclude leaves it out. */
  addStart(path: string): void {
    this.add({ url: this.urlFor(path), route: path }, true);
  }

  addPattern(pattern: RoutePattern): void {
    if (this.patterns.has(pattern.path) || !this.baseUrl) return;
    this.patterns.set(pattern.path, pattern);
    const path = staticUrlPath(pattern);
    if (path !== null) {
      this.add({ url: this.urlFor(path), route: pattern.path });
      return;
    }
    const sample = this.samples[pattern.path];
    if (sample) this.add({ url: this.urlFor(sample), route: pattern.path });
    else this.waiting.set(pattern.path, pattern);
  }

  /** Links from a scanned page: samples for dynamic routes, and new pages when crawling. */
  addLinks(found: string[]): void {
    if (!this.baseUrl) return;
    // Never a logout, delete or file link, not even as a sample for a dynamic route.
    const links = found
      .map((link) => this.linkPath(link))
      .filter((p): p is string => p !== null && isCrawlable(p));
    if (this.waiting.size) {
      for (const link of links) {
        const route = routeFor(link, this.patterns.values());
        if (route && this.waiting.has(route.path)) {
          this.waiting.delete(route.path);
          this.add({ url: this.urlFor(link), route: route.path });
        }
      }
    }
    if (this.crawler) {
      for (const path of this.crawler.add(links)) this.add({ url: this.urlFor(path), route: path });
    }
  }

  /** A redirect to a page that's scanned anyway isn't worth scanning twice. */
  redirectTarget(requested: string, final: string): string | null {
    if (new URL(final).origin !== new URL(requested).origin) return null;
    const to = this.keyOf(final);
    if (to === this.keyOf(requested)) return null;
    if (this.planned.has(to)) return to;
    this.planned.add(to);
    return null;
  }
}
