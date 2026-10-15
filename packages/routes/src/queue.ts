import { type Crawler, isCrawlable, routeFor } from './crawl';
import { type RoutePattern, type Segment, staticUrlPath } from './pattern';

/** A page to scan: its URL, and the route it stands for (`/blog/[slug]` for `/blog/hello`). */
export interface Target {
  url: string;
  route: string;
}

/** The parameter names in a segment's label: `[slug]`, `[[lang]]`, `[...path]`, `post-[id]`. */
function namesIn(label: string): string[] {
  return [...label.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g)].map((m) => m[1] as string);
}

/** A whole segment that is one parameter, like `[slug]` (not `post-[id]`, an optional or a catch-all). */
function isPlainParam(s: Segment): boolean {
  return (
    s.kind === 'param' &&
    !s.optional &&
    namesIn(s.label).length === 1 &&
    s.label.startsWith('[') &&
    s.label.endsWith(']')
  );
}

/** The route up to and including segment `i`, the key a parameter's value is shared under. */
function prefixOf(segments: Segment[], i: number): string {
  return `/${segments
    .slice(0, i + 1)
    .map((s) => (s.kind === 'static' ? s.value : s.label))
    .join('/')}`;
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
  /** For routes left waiting at the end: the parameters nothing gave a value. */
  readonly missing = new Map<string, string[]>();
  /**
   * Values parameters took in real URLs, under the route they belong to: `/users/[username]` →
   * `jane`. Routes below it reuse them, since a child of a real page is real too.
   */
  private readonly seen = new Map<string, string>();
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
    /** Values for parameters by name, from the config, for routes no link fits. */
    private readonly params: Record<string, string> = {},
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
    if (sample) {
      const samplePath = /^https?:\/\//i.test(sample)
        ? this.appPath(new URL(sample).pathname)
        : sample;
      if (samplePath !== null) this.learn(pattern, samplePath);
      this.add({ url: this.urlFor(sample), route: pattern.path });
    } else this.waiting.set(pattern.path, pattern);
  }

  /** Remembers the values a real URL gives a route's parameters. */
  private learn(pattern: RoutePattern, path: string): void {
    if (pattern.segments.some((s) => s.kind === 'rest' || (s.kind === 'param' && s.optional)))
      return;
    const parts = (path.split(/[?#]/)[0] as string).split('/').filter(Boolean);
    if (parts.length !== pattern.segments.length) return;
    pattern.segments.forEach((s, i) => {
      if (isPlainParam(s)) {
        const key = prefixOf(pattern.segments, i);
        if (!this.seen.has(key)) this.seen.set(key, parts[i] as string);
      }
    });
  }

  /**
   * A URL for a dynamic route from values already known: a parent route's real URL, then the
   * config's params by name. Null, with the names still needed, when something is missing.
   */
  private build(pattern: RoutePattern): { path: string } | { missing: string[] } {
    const parts: string[] = [];
    const missing: string[] = [];
    pattern.segments.forEach((s, i) => {
      if (s.kind === 'static') {
        parts.push(s.value);
        return;
      }
      const inherited = isPlainParam(s) ? this.seen.get(prefixOf(pattern.segments, i)) : undefined;
      if (inherited !== undefined) {
        parts.push(inherited);
        return;
      }
      const names = namesIn(s.label);
      const absent = names.filter((n) => this.params[n] === undefined);
      if (absent.length) {
        if (!s.optional) missing.push(...absent);
        return;
      }
      let value = s.label;
      // A function, so a $ in the value is kept as it is.
      for (const n of names)
        value = value.replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/, () => this.params[n] as string);
      parts.push(value.replace(/^\/+|\/+$/g, ''));
    });
    return missing.length ? { missing: [...new Set(missing)] } : { path: `/${parts.join('/')}` };
  }

  /**
   * Gives the routes no link fitted a URL from known values, once the links have had their
   * chance. Returns how many were added; the rest stay waiting, with what they're missing.
   */
  fillWaiting(): number {
    let added = 0;
    for (const [key, pattern] of this.waiting) {
      const built = this.build(pattern);
      if ('missing' in built) {
        this.missing.set(key, built.missing);
        continue;
      }
      this.waiting.delete(key);
      this.missing.delete(key);
      this.add({ url: this.urlFor(built.path), route: pattern.path });
      added++;
    }
    return added;
  }

  /** Links from a scanned page: samples for dynamic routes, and new pages when crawling. */
  addLinks(found: string[]): void {
    if (!this.baseUrl) return;
    // Never a logout, delete or file link, not even as a sample for a dynamic route.
    const links = found
      .map((link) => this.linkPath(link))
      .filter((p): p is string => p !== null && isCrawlable(p));
    if (this.patterns.size) {
      for (const link of links) {
        const route = routeFor(link, this.patterns.values());
        if (!route?.dynamic) continue;
        // Even when its route has a URL already: routes below it may need its values.
        this.learn(route, link);
        if (this.waiting.has(route.path)) {
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
