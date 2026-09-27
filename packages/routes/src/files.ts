import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  createPattern,
  param,
  type RoutePattern,
  rest,
  type Segment,
  staticSegment,
} from './pattern';
import { dropShadowedRoot, fromBracketPath, fromTanstackPath } from './syntax';

/** Folders that never hold routes, and would be slow to walk. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'dist',
]);
const MAX_FILES = 20_000;

/** Every file under `dir`, relative to it with `/` separators. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
          walk(join(current, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(dir, join(current, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

function isTestFile(file: string): boolean {
  return /(^|\/)__tests__\/|\.(test|spec|stories)\.[jt]sx?$/.test(file);
}

function dedupe(patterns: (RoutePattern | null)[]): RoutePattern[] {
  const seen = new Map<string, RoutePattern>();
  for (const p of patterns) if (p && !seen.has(p.path)) seen.set(p.path, p);
  return dropShadowedRoot([...seen.values()]);
}

/** Next.js App Router: folders with a page file. */
export function nextAppRoutes(files: string[]): RoutePattern[] {
  return dedupe(
    files
      .filter((f) => /(^|\/)page\.(tsx|ts|jsx|js|mdx|md)$/.test(f) && !isTestFile(f))
      .map((f) => {
        const dirs = f.split('/').slice(0, -1);
        // Private folders, parallel-route slots and intercepted routes aren't URLs of their own.
        if (dirs.some((d) => d.startsWith('_') || d.startsWith('@') || /^\(\.{1,3}\)/.test(d))) {
          return null;
        }
        return fromBracketPath(dirs, { restMatchesNothing: false });
      }),
  );
}

const NEXT_PAGES_SPECIAL = new Set(['_app', '_document', '_error', '404', '500', '_middleware']);

/** Next.js Pages Router. */
export function nextPagesRoutes(files: string[]): RoutePattern[] {
  return dedupe(
    files
      .filter((f) => /\.(tsx|ts|jsx|js|mdx|md)$/.test(f) && !isTestFile(f) && !f.startsWith('api/'))
      .map((f) => {
        const parts = f.replace(/\.[^.]+$/, '').split('/');
        if (parts.length === 1 && NEXT_PAGES_SPECIAL.has(parts[0] as string)) return null;
        if (parts.at(-1) === 'index') parts.pop();
        return fromBracketPath(parts, { restMatchesNothing: false });
      }),
  );
}

/** Nuxt: every page component under pages/. `[...slug]` also matches nothing in Nuxt. */
export function nuxtRoutes(files: string[]): RoutePattern[] {
  return dedupe(
    files
      .filter((f) => /\.(vue|tsx|jsx)$/.test(f) && !isTestFile(f))
      .map((f) => {
        const parts = f.replace(/\.[^.]+$/, '').split('/');
        if (parts.at(-1) === 'index') parts.pop();
        return fromBracketPath(parts, { restMatchesNothing: true });
      }),
  );
}

/** SvelteKit: folders with a +page file. */
export function sveltekitRoutes(files: string[]): RoutePattern[] {
  return dedupe(
    files
      .filter((f) => /(^|\/)\+page(@[^.]*)?\.(svelte|md|svx)$/.test(f))
      .map((f) => fromBracketPath(f.split('/').slice(0, -1), { restMatchesNothing: true })),
  );
}

/** Astro: pages that render HTML. Files and folders starting with _ are skipped. */
export function astroRoutes(files: string[]): RoutePattern[] {
  return dedupe(
    files
      .filter((f) => /\.(astro|md|mdx|markdown|html)$/.test(f))
      .map((f) => {
        const parts = f.replace(/\.[^.]+$/, '').split('/');
        if (parts.some((p) => p.startsWith('_'))) return null;
        if (parts.at(-1) === 'index') parts.pop();
        return fromBracketPath(parts, { restMatchesNothing: true });
      }),
  );
}

/** Splits a flat route name on dots, except inside [escapes]. */
function splitFlatName(name: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of name) {
    if (ch === '[') escaped = true;
    else if (ch === ']') escaped = false;
    if (ch === '.' && !escaped) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Remix v2 and React Router 7 flat routes: `blog.$slug.tsx`, `_auth.login.tsx`, `($lang)._index.tsx`. */
export function remixFlatRoutes(files: string[]): RoutePattern[] {
  const names: string[] = [];
  for (const f of files) {
    if (isTestFile(f)) continue;
    // A folder is a route when it has a route file; anything else in it is a module it uses.
    const folder = f.match(/^([^/]+)\/route\.(tsx|jsx|js|mdx|md)$/);
    if (folder?.[1]) {
      names.push(folder[1]);
      continue;
    }
    // Only files at the top level are routes (.ts files are resource routes, not pages).
    const file = f.match(/^([^/]+)\.(tsx|jsx|js|mdx|md)$/);
    if (file?.[1]) names.push(file[1]);
  }
  return dedupe(names.map(flatNameToPattern));
}

export function flatNameToPattern(name: string): RoutePattern | null {
  const segments: Segment[] = [];
  for (const raw of splitFlatName(name)) {
    if (raw === '_index' || raw === 'index' || raw === 'route') continue;
    // A leading underscore makes a layout that adds nothing to the URL.
    if (raw.startsWith('_')) continue;
    const part = raw.endsWith('_') ? raw.slice(0, -1) : raw;
    if (part === '$') {
      segments.push(rest('splat', true));
      continue;
    }
    let m = part.match(/^\(\$([\w-]+)\)$/);
    if (m?.[1]) {
      segments.push(param(m[1], true));
      continue;
    }
    // An optional static segment: scan the shorter URL.
    if (/^\(.*\)$/.test(part)) continue;
    m = part.match(/^\$([\w-]+)$/);
    if (m?.[1]) {
      segments.push(param(m[1]));
      continue;
    }
    const literal = part.replace(/\[([^\]]*)\]/g, '$1');
    // sitemap[.]xml and friends are files, not pages.
    if (/\.(xml|txt|json|rss|ico|png|jpe?g|svg|webmanifest)$/i.test(literal)) return null;
    segments.push(staticSegment(literal));
  }
  const pattern = createPattern(segments);
  return pattern.segments.every((s) => s.kind === 'rest') && pattern.segments.length
    ? null
    : pattern;
}

/** TanStack Router's generated route tree lists every full path. */
export function tanstackRoutes(source: string): RoutePattern[] {
  const block = source.match(/interface\s+FileRoutesByFullPath\s*\{([\s\S]*?)\n\}/);
  const keys = block?.[1]
    ? [...block[1].matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)].map((m) => m[1] as string)
    : [...source.matchAll(/\bfullPath:\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
  return dedupe(keys.filter((k) => k.startsWith('/')).map(fromTanstackPath));
}

export interface FileRoutes {
  /** Human description of where the routes came from, e.g. "src/app". */
  from: string;
  routes: RoutePattern[];
}

function firstDir(root: string, candidates: string[]): string | null {
  return candidates.find((c) => existsSync(join(root, c))) ?? null;
}

function nuxtPagesDir(root: string): string | null {
  let srcDir: string | undefined;
  for (const name of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    srcDir = readFileSync(file, 'utf8').match(/\bsrcDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    break;
  }
  const candidates = srcDir ? [join(srcDir, 'pages')] : ['app/pages', 'pages', 'src/pages'];
  return firstDir(root, candidates);
}

/** Routes read from the project's files, for frameworks that route by file name. */
export function fileRoutes(root: string, framework: string): FileRoutes | null {
  switch (framework) {
    case 'next': {
      const app = firstDir(root, ['src/app', 'app']);
      const pages = firstDir(root, ['src/pages', 'pages']);
      const routes = [
        ...(app ? nextAppRoutes(listFiles(join(root, app))) : []),
        ...(pages ? nextPagesRoutes(listFiles(join(root, pages))) : []),
      ];
      if (!app && !pages) return null;
      return { from: [app, pages].filter(Boolean).join(' and '), routes: dedupe(routes) };
    }
    case 'nuxt': {
      const dir = nuxtPagesDir(root);
      return dir ? { from: dir, routes: nuxtRoutes(listFiles(join(root, dir))) } : null;
    }
    case 'sveltekit': {
      const dir = firstDir(root, ['src/routes']);
      return dir ? { from: dir, routes: sveltekitRoutes(listFiles(join(root, dir))) } : null;
    }
    case 'astro': {
      const dir = firstDir(root, ['src/pages']);
      return dir ? { from: dir, routes: astroRoutes(listFiles(join(root, dir))) } : null;
    }
    case 'remix':
    case 'react-router': {
      const dir = firstDir(root, ['app/routes']);
      return dir ? { from: dir, routes: remixFlatRoutes(listFiles(join(root, dir))) } : null;
    }
    case 'tanstack': {
      const file = firstDir(root, [
        'src/routeTree.gen.ts',
        'app/routeTree.gen.ts',
        'src/routeTree.gen.js',
      ]);
      return file
        ? { from: file, routes: tanstackRoutes(readFileSync(join(root, file), 'utf8')) }
        : null;
    }
    default:
      return null;
  }
}
