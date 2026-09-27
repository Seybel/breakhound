import {
  createPattern,
  mixed,
  param,
  type RoutePattern,
  rest,
  type Segment,
  staticSegment,
} from './pattern';

/**
 * Converters from each router's path syntax (as found in a live router or in
 * source code) into a RoutePattern. Returns null for routes that aren't pages
 * a person would visit, such as a catch-all 404.
 */

/** Joins a child route to its parent; a parent like "account/*" hands "account" to its children. */
function joinPaths(base: string, path: string): string {
  if (path.startsWith('/')) return path;
  return `${base.replace(/\/?\*$/, '').replace(/\/+$/, '')}/${path}`;
}

export { joinPaths };

/** A catch-all at the root is the "not found" page, and it matches every link. */
function isRootCatchAll(pattern: RoutePattern): boolean {
  return pattern.segments.length > 0 && pattern.segments.every((s) => s.kind === 'rest');
}

function finish(segments: Segment[]): RoutePattern | null {
  const pattern = createPattern(segments);
  return isRootCatchAll(pattern) ? null : pattern;
}

/** React Router: `/users/:id`, `:lang?`, trailing `*`. */
export function fromReactRouterPath(path: string): RoutePattern | null {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg): Segment => {
      if (seg === '*') return rest('rest', true);
      const m = seg.match(/^:([\w-]+)(\?)?$/);
      if (m?.[1]) return param(m[1], Boolean(m[2]));
      if (seg.endsWith('?')) return param(seg.slice(0, -1), true);
      return staticSegment(seg);
    });
  return finish(segments);
}

/** Vue Router 4 (also Nuxt): `/user/:id`, `:id(\\d+)?`, `:slug(.*)*`, `:id()`. */
export function fromVueRouterPath(path: string): RoutePattern | null {
  const segments: Segment[] = [];
  for (const seg of path.split('/').filter(Boolean)) {
    const tokens = [...seg.matchAll(/:([\w]+)(\((?:[^()]|\([^()]*\))*\))?([?*+])?/g)];
    if (!tokens.length) {
      segments.push(staticSegment(seg));
      continue;
    }
    if (tokens.length === 1 && tokens[0]?.[0] === seg) {
      const [, name = 'param', regex = '', modifier] = tokens[0];
      const repeat = modifier === '*' || modifier === '+' || /\.\*|\.\+/.test(regex);
      const optional =
        modifier === '?' || modifier === '*' || (/\.\*/.test(regex) && modifier !== '+');
      segments.push(repeat ? rest(name, optional) : param(name, optional));
      continue;
    }
    const parts: (string | { name: string })[] = [];
    let last = 0;
    for (const t of tokens) {
      if (t.index > last) parts.push(seg.slice(last, t.index));
      parts.push({ name: t[1] as string });
      last = t.index + t[0].length;
    }
    if (last < seg.length) parts.push(seg.slice(last));
    segments.push(mixed(parts));
  }
  return finish(segments);
}

/** TanStack Router full paths: `/posts/$postId`, `$` splat, `{-$lang}` optional. */
export function fromTanstackPath(path: string): RoutePattern | null {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg): Segment => {
      if (seg === '$') return rest('splat', true);
      let m = seg.match(/^\{-\$([\w]+)\}$/);
      if (m?.[1]) return param(m[1], true);
      m = seg.match(/^\$([\w]+)$/);
      if (m?.[1]) return param(m[1]);
      const parts: (string | { name: string })[] = [];
      let last = 0;
      for (const t of seg.matchAll(/\{\$([\w]+)\}/g)) {
        if (t.index > last) parts.push(seg.slice(last, t.index));
        parts.push({ name: t[1] as string });
        last = t.index + t[0].length;
      }
      if (last < seg.length) parts.push(seg.slice(last));
      return mixed(parts);
    });
  return finish(segments);
}

/** File-system segments shared by Next, Nuxt, SvelteKit and Astro: `[id]`, `[[id]]`, `[...slug]`. */
export function bracketSegment(seg: string, opts: { restMatchesNothing: boolean }): Segment | null {
  // Route groups like (marketing) don't show up in the URL.
  if (/^\(.*\)$/.test(seg)) return null;
  let m = seg.match(/^\[\[\.\.\.([^\]=]+)(?:=[^\]]+)?\]\]$/);
  if (m?.[1]) return rest(m[1], true);
  m = seg.match(/^\[\.\.\.([^\]=]+)(?:=[^\]]+)?\]$/);
  if (m?.[1]) return rest(m[1], opts.restMatchesNothing);
  m = seg.match(/^\[\[([^\]=]+)(?:=[^\]]+)?\]\]$/);
  if (m?.[1]) return param(m[1], true);
  const parts: (string | { name: string })[] = [];
  let last = 0;
  for (const t of seg.matchAll(/\[([^\]=]+)(?:=[^\]]+)?\]/g)) {
    if (t.index > last) parts.push(seg.slice(last, t.index));
    parts.push({ name: t[1] as string });
    last = t.index + t[0].length;
  }
  if (last < seg.length) parts.push(seg.slice(last));
  return mixed(parts);
}

export function fromBracketPath(
  dirs: string[],
  opts: { restMatchesNothing: boolean },
): RoutePattern | null {
  const segments: Segment[] = [];
  for (const d of dirs) {
    const s = bracketSegment(d, opts);
    if (s) segments.push(s);
  }
  return finish(segments);
}
