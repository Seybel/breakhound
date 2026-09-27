/**
 * Every framework spells dynamic routes differently (`[id]`, `:id`, `$id`).
 * They're all turned into one shape here and shown the Next.js way:
 * `/blog/[slug]`, `/docs/[...path]`, `/[[lang]]`.
 */

export type Segment =
  | { kind: 'static'; value: string }
  /** One path segment, possibly mixed with text (`post-[id]`). */
  | { kind: 'param'; label: string; source: string; optional: boolean }
  /** Any number of segments (at least one unless optional). */
  | { kind: 'rest'; label: string; optional: boolean };

export interface RoutePattern {
  /** Display form, e.g. `/blog/[slug]`. Also the key used in `samples`. */
  path: string;
  segments: Segment[];
  /** True when a URL can't be built without a real value for a parameter. */
  dynamic: boolean;
}

const PARAM_SOURCE = '[^/]+';

export function staticSegment(value: string): Segment {
  return { kind: 'static', value };
}

export function param(name: string, optional = false): Segment {
  return {
    kind: 'param',
    label: optional ? `[[${name}]]` : `[${name}]`,
    source: PARAM_SOURCE,
    optional,
  };
}

export function rest(name: string, optional: boolean): Segment {
  return { kind: 'rest', label: optional ? `[[...${name}]]` : `[...${name}]`, optional };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A segment made of text and parameters, like `post-[id]` or `[a]-[b]`. */
export function mixed(parts: (string | { name: string })[]): Segment {
  if (parts.every((p) => typeof p === 'string')) return staticSegment(parts.join(''));
  if (parts.length === 1 && typeof parts[0] === 'object') return param(parts[0].name);
  return {
    kind: 'param',
    label: parts.map((p) => (typeof p === 'string' ? p : `[${p.name}]`)).join(''),
    source: parts.map((p) => (typeof p === 'string' ? escapeRegExp(p) : PARAM_SOURCE)).join(''),
    optional: false,
  };
}

export function createPattern(segments: Segment[]): RoutePattern {
  const clean = segments.filter((s) => !(s.kind === 'static' && s.value === ''));
  const path = `/${clean.map((s) => (s.kind === 'static' ? s.value : s.label)).join('/')}`;
  return {
    path,
    segments: clean,
    dynamic: clean.some((s) => s.kind !== 'static' && !s.optional),
  };
}

/** The URL for a route that needs no sample (optional parameters left out). */
export function staticUrlPath(pattern: RoutePattern): string | null {
  if (pattern.dynamic) return null;
  const parts = pattern.segments.flatMap((s) => (s.kind === 'static' ? [s.value] : []));
  return `/${parts.join('/')}`;
}

function segmentSource(s: Segment): string {
  if (s.kind === 'static') return `/${escapeRegExp(s.value)}`;
  if (s.kind === 'param') return s.optional ? `(?:/${s.source})?` : `/${s.source}`;
  return s.optional ? '(?:/.+)?' : '/.+';
}

const matchers = new WeakMap<RoutePattern, RegExp>();

/** Whether a URL path (no query) is an instance of the pattern. */
export function matchesPattern(pattern: RoutePattern, pathname: string): boolean {
  let re = matchers.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.segments.map(segmentSource).join('') || '/'}/?$`, 'i');
    matchers.set(pattern, re);
  }
  let path = pathname;
  try {
    path = decodeURI(pathname);
  } catch {
    // Keep the raw path when it isn't valid percent-encoding.
  }
  return re.test(path);
}

/** Rank of a segment when two patterns match the same URL; "none" means the pattern already ended. */
function segmentRank(s: Segment | undefined): number {
  if (!s) return 4;
  if (s.kind === 'static') return 5;
  if (s.kind === 'param') return s.optional ? 2 : 3;
  return s.optional ? 0 : 1;
}

const MAX_RANKED_SEGMENTS = 12;

/**
 * How specific a pattern is, so `/blog/new` wins over `/blog/[slug]`, and
 * `/blog/[slug]` over `/[[lang]]/blog/[slug]`, for the same URL. Segments
 * are compared left to right: text beats a parameter, which beats a catch-all.
 */
export function specificity(pattern: RoutePattern): number {
  let score = 0;
  for (let i = 0; i < MAX_RANKED_SEGMENTS; i++)
    score = score * 6 + segmentRank(pattern.segments[i]);
  return score;
}

/** Parses the display form back (for `samples` keys and config routes). */
export function parsePattern(path: string): RoutePattern {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg): Segment => {
      let m = seg.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
      if (m?.[1]) return rest(m[1], true);
      m = seg.match(/^\[\.\.\.([^\]]+)\]$/);
      if (m?.[1]) return rest(m[1], false);
      m = seg.match(/^\[\[([^\]]+)\]\]$/);
      if (m?.[1]) return param(m[1], true);
      return mixed(splitBrackets(seg));
    });
  return createPattern(segments);
}

function splitBrackets(seg: string): (string | { name: string })[] {
  const parts: (string | { name: string })[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  for (const m of seg.matchAll(re)) {
    if (m.index > last) parts.push(seg.slice(last, m.index));
    parts.push({ name: m[1] as string });
    last = m.index + m[0].length;
  }
  if (last < seg.length) parts.push(seg.slice(last));
  return parts;
}

/**
 * Glob over route patterns: `*` is one segment, `**` any number.
 * `/admin/**` matches `/admin` and everything below it.
 */
export function globMatches(glob: string, path: string): boolean {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*' && glob[i + 1] === '*') {
      // "/**" also matches the folder itself.
      if (source.endsWith('/')) source = `${source.slice(0, -1)}(?:/.*)?`;
      else source += '.*';
      i++;
    } else if (ch === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}/?$`).test(path);
}

/** A made-up URL for hints, e.g. /products/[id] → /products/1. */
export function examplePath(path: string): string {
  return path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, 'a/b').replace(/\[\[?[^\]]+\]\]?/g, '1');
}
