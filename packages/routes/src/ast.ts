import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type ParserPlugin, parse } from '@babel/parser';
import { listFiles, remixFlatRoutes } from './files';
import type { RoutePattern } from './pattern';
import { fromAngularPath, fromReactRouterPath, fromVueRouterPath, joinPaths } from './syntax';

/**
 * The static fallback for routes defined in code, used when the live router
 * can't be read (for example when every page sits behind a login). It follows
 * imports from the app's entry file so leftovers that nothing imports are
 * ignored, and reads `<Route path>` elements and `{ path, children }` objects
 * (React Router, Vue Router and Angular).
 */

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked generically.
type Node = any;

const MAX_FILES = 1000;
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue'];

function parseSource(file: string, code: string): Node | null {
  const plugins: ParserPlugin[] = ['decorators-legacy'];
  if (/\.tsx?$|\.vue$/.test(file)) plugins.push('typescript');
  if (!/\.ts$/.test(file)) plugins.push('jsx');
  try {
    return parse(code, { sourceType: 'module', plugins, errorRecovery: true });
  } catch {
    return null;
  }
}

/** Vue single-file components keep their code in <script> blocks. */
function scriptOf(file: string, code: string): string {
  if (!file.endsWith('.vue')) return code;
  return [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

function walk(
  node: Node,
  visit: (n: Node, parent: Node | null) => boolean | undefined,
  parent: Node | null = null,
): void {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === 'string') walk(child, visit, node);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, node);
    }
  }
}

function resolveImport(from: string, spec: string, root: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/') || spec.startsWith('~/')) base = join(root, 'src', spec.slice(2));
  else if (spec.startsWith('src/')) base = join(root, spec);
  else return null;
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, `index${e}`)),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile() && EXTENSIONS.some((e) => c.endsWith(e))) return c;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** The files a browser would load first: index.html's module script, or the usual entry names. */
export function entryFiles(root: string): string[] {
  const html = join(root, 'index.html');
  const entries: string[] = [];
  if (existsSync(html)) {
    for (const m of readFileSync(html, 'utf8').matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
      const src = (m[1] as string).replace(/^\//, '');
      const file = resolveImport(join(root, 'index.html'), `./${src}`, root);
      if (file) entries.push(file);
    }
  }
  if (!entries.length) {
    for (const name of ['main', 'index', 'App', 'app', 'router', 'routes']) {
      const file = resolveImport(join(root, 'src', 'x'), `./${name}`, root);
      if (file) entries.push(file);
    }
  }
  return entries;
}

function attrValue(el: Node, name: string): string | boolean | undefined {
  const attr = el.openingElement.attributes.find(
    (a: Node) => a.type === 'JSXAttribute' && a.name?.name === name,
  );
  if (!attr) return undefined;
  if (attr.value === null) return true;
  if (attr.value.type === 'StringLiteral') return attr.value.value;
  const expr = attr.value.expression;
  if (expr?.type === 'StringLiteral') return expr.value;
  if (expr?.type === 'BooleanLiteral') return expr.value;
  if (expr?.type === 'TemplateLiteral' && expr.expressions.length === 0)
    return expr.quasis[0]?.value.cooked;
  return undefined;
}

function jsxName(el: Node): string {
  const n = el.openingElement?.name;
  if (n?.type === 'JSXIdentifier') return n.name;
  if (n?.type === 'JSXMemberExpression') return n.property.name;
  return '';
}

function propValue(obj: Node, name: string): Node | undefined {
  return obj.properties.find(
    (p: Node) =>
      p.type === 'ObjectProperty' &&
      ((p.key.type === 'Identifier' && p.key.name === name) ||
        (p.key.type === 'StringLiteral' && p.key.value === name)),
  )?.value;
}

const ROUTE_OBJECT_KEYS = [
  'element',
  'component',
  'Component',
  'lazy',
  'children',
  'loader',
  'components',
  'name',
  // Angular
  'loadComponent',
  'loadChildren',
  'redirectTo',
  'pathMatch',
];

function isRouteObject(obj: Node): boolean {
  const path = propValue(obj, 'path');
  if (path?.type !== 'StringLiteral' && propValue(obj, 'index')?.value !== true) return false;
  return ROUTE_OBJECT_KEYS.some((k) => propValue(obj, k) !== undefined);
}

interface Found {
  paths: string[];
  /** Files of lazily loaded child routes (Angular's loadChildren), with the path they sit under. */
  bases: Map<string, string>;
}

/** The file a `() => import('./admin/admin.routes')` loads. */
function importedFile(fn: Node, from: string, root: string): string | null {
  let spec: string | null = null;
  walk(fn, (n) => {
    if (spec) return false;
    if (n.type === 'ImportExpression' && n.source?.type === 'StringLiteral') spec = n.source.value;
    else if (
      n.type === 'CallExpression' &&
      n.callee.type === 'Import' &&
      n.arguments[0]?.type === 'StringLiteral'
    )
      spec = n.arguments[0].value;
    return true;
  });
  return spec ? resolveImport(from, spec, root) : null;
}

/** An index route under "settings/*" is the page at /settings. */
function indexPath(base: string): string {
  return base.replace(/\/?\*$/, '') || '/';
}

function collectRoutes(ast: Node, found: Found, file: string, root: string): void {
  const done = new WeakSet<Node>();
  const fileBase = found.bases.get(file) ?? '';

  const fromObject = (obj: Node, base: string) => {
    done.add(obj);
    if (propValue(obj, 'redirect') || propValue(obj, 'redirectTo')) return;
    const path = propValue(obj, 'path');
    const full = path?.type === 'StringLiteral' ? joinPaths(base, path.value) : base;
    const lazy = propValue(obj, 'loadChildren');
    const childFile = lazy ? importedFile(lazy, file, root) : null;
    if (childFile) {
      // Its own routes say which pages are there, starting at this path.
      if (!found.bases.has(childFile)) found.bases.set(childFile, full);
    } else if (path?.type === 'StringLiteral') found.paths.push(full || '/');
    else if (propValue(obj, 'index')?.value === true) found.paths.push(indexPath(base));
    const children = propValue(obj, 'children');
    if (children?.type === 'ArrayExpression') {
      for (const child of children.elements) {
        if (child?.type === 'ObjectExpression' && isRouteObject(child)) fromObject(child, full);
      }
    }
  };

  const fromElement = (el: Node, base: string) => {
    done.add(el);
    const path = attrValue(el, 'path');
    const full = typeof path === 'string' ? joinPaths(base, path) : base;
    if (typeof path === 'string') found.paths.push(full || '/');
    else if (attrValue(el, 'index') === true) found.paths.push(indexPath(base));
    for (const child of el.children) {
      if (child.type === 'JSXElement' && /Route$/.test(jsxName(child))) fromElement(child, full);
    }
  };

  walk(ast, (n) => {
    if (done.has(n)) return false;
    if (n.type === 'JSXElement' && /Route$/.test(jsxName(n))) {
      const hasRouteShape =
        attrValue(n, 'path') !== undefined ||
        attrValue(n, 'index') !== undefined ||
        n.children.some((c: Node) => c.type === 'JSXElement' && /Route$/.test(jsxName(c)));
      if (hasRouteShape) {
        fromElement(n, fileBase);
        return false;
      }
    }
    if (n.type === 'ObjectExpression' && isRouteObject(n)) {
      fromObject(n, fileBase);
      return false;
    }
    return true;
  });
}

export interface SourceRoutes {
  files: number;
  routes: RoutePattern[];
}

/** Routes defined in code, following imports from the entry files. */
export function sourceRoutes(root: string, syntax: 'react' | 'vue' | 'angular'): SourceRoutes {
  const queue = entryFiles(root);
  const seen = new Set(queue);
  const found: Found = { paths: [], bases: new Map() };
  while (queue.length && seen.size <= MAX_FILES) {
    const file = queue.shift() as string;
    let code: string;
    try {
      code = scriptOf(file, readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const ast = parseSource(file, code);
    if (!ast) continue;
    collectRoutes(ast, found, file, root);
    walk(ast, (n) => {
      let spec: string | undefined;
      if (
        (n.type === 'ImportDeclaration' ||
          n.type === 'ExportNamedDeclaration' ||
          n.type === 'ExportAllDeclaration') &&
        n.source?.type === 'StringLiteral'
      ) {
        if (n.importKind === 'type' || n.exportKind === 'type') return true;
        spec = n.source.value;
      } else if (n.type === 'ImportExpression' && n.source?.type === 'StringLiteral') {
        spec = n.source.value;
      } else if (
        n.type === 'CallExpression' &&
        (n.callee.type === 'Import' || n.callee.name === 'require') &&
        n.arguments[0]?.type === 'StringLiteral'
      ) {
        spec = n.arguments[0].value;
      }
      if (spec) {
        const target = resolveImport(file, spec, root);
        if (target && !seen.has(target) && !target.includes('node_modules')) {
          seen.add(target);
          queue.push(target);
        }
      }
      return true;
    });
  }
  const convert =
    syntax === 'vue'
      ? fromVueRouterPath
      : syntax === 'angular'
        ? fromAngularPath
        : fromReactRouterPath;
  const routes = new Map<string, RoutePattern>();
  for (const p of found.paths) {
    const pattern = convert(p);
    if (pattern && !routes.has(pattern.path)) routes.set(pattern.path, pattern);
  }
  return { files: seen.size, routes: [...routes.values()] };
}

/** React Router 7's app/routes.ts: `route()`, `index()`, `layout()`, `prefix()` and `flatRoutes()`. */
export function routeConfigRoutes(root: string): RoutePattern[] | null {
  const file = ['app/routes.ts', 'app/routes.js', 'app/routes.tsx']
    .map((f) => join(root, f))
    .find(existsSync);
  if (!file) return null;
  const ast = parseSource(file, readFileSync(file, 'utf8'));
  if (!ast) return null;
  const paths: string[] = [];
  let usesFlatRoutes = false;

  const unwrap = (n: Node): Node => {
    let node = n;
    while (
      node &&
      [
        'TSSatisfiesExpression',
        'TSAsExpression',
        'AwaitExpression',
        'ParenthesizedExpression',
      ].includes(node.type)
    ) {
      node = node.expression ?? node.argument;
    }
    return node;
  };
  const visitList = (list: Node, base: string) => {
    const node = unwrap(list);
    if (node?.type !== 'ArrayExpression') return;
    for (const raw of node.elements) {
      const el = unwrap(raw?.type === 'SpreadElement' ? raw.argument : raw);
      if (el?.type !== 'CallExpression') continue;
      const name = el.callee.type === 'Identifier' ? el.callee.name : el.callee.property?.name;
      const [a0, a1, a2, a3] = el.arguments.map(unwrap);
      if (name === 'index') paths.push(base || '/');
      else if (name === 'route' && a0?.type === 'StringLiteral') {
        const full = joinPaths(base, a0.value);
        paths.push(full);
        visitList(a2?.type === 'ArrayExpression' ? a2 : a3, full);
      } else if (name === 'layout') visitList(a1, base);
      else if (name === 'prefix' && a0?.type === 'StringLiteral')
        visitList(a1, joinPaths(base, a0.value));
      else if (name === 'flatRoutes') usesFlatRoutes = true;
    }
  };

  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ExportDefaultDeclaration') continue;
    let decl = unwrap(stmt.declaration);
    if (decl?.type === 'Identifier') {
      for (const s of ast.program.body) {
        const d = s.type === 'VariableDeclaration' ? s : s.declaration;
        const v = d?.declarations?.find((x: Node) => x.id?.name === decl.name);
        if (v) decl = unwrap(v.init);
      }
    }
    // `export default flatRoutes()` on its own.
    if (decl?.type === 'CallExpression' && decl.callee.name === 'flatRoutes') usesFlatRoutes = true;
    visitList(decl, '');
  }

  const routes = new Map<string, RoutePattern>();
  for (const p of paths) {
    const pattern = fromReactRouterPath(p);
    if (pattern) routes.set(pattern.path, pattern);
  }
  if (usesFlatRoutes && existsSync(join(root, 'app/routes'))) {
    for (const p of remixFlatRoutes(listFiles(join(root, 'app/routes')))) routes.set(p.path, p);
  }
  return [...routes.values()];
}

export function describeFile(root: string, file: string): string {
  return relative(root, file).split('\\').join('/');
}
