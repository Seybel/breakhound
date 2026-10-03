import { createRequire } from 'node:module';
import { extname, join, relative, sep } from 'node:path';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

/**
 * Marks every HTML element in a component with where it's written:
 * `<nav data-bh-src="src/components/Nav.tsx:42:7">`. breakhound reads the
 * attribute back when it finds an issue, so the agent goes straight to the
 * right line. Only for development builds; components (capitalised tags)
 * and library code are left alone.
 */

export const SOURCE_ATTR = 'data-bh-src';

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
}

// biome-ignore lint/suspicious/noExplicitAny: AST nodes are walked generically.
type Node = any;

function walk(node: Node, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  // Babel and Svelte name their node types; Vue numbers them.
  if (typeof node.type === 'string' || typeof node.type === 'number') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function attr(file: string, line: number, column: number): string {
  return ` ${SOURCE_ATTR}="${file}:${line}:${column}"`;
}

/** Lowercase JSX tags are HTML (and SVG) elements; capitalised ones are components. */
function jsx(code: string, file: string, typescript: boolean): MagicString | null {
  // Lowercase tags in React Three Fiber are 3D objects, not elements.
  if (code.includes('@react-three/fiber')) return null;
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: typescript ? ['jsx', 'typescript', 'decorators-legacy'] : ['jsx'],
    });
  } catch {
    return null;
  }
  const s = new MagicString(code);
  let changed = false;
  walk(ast.program, (n) => {
    if (n.type !== 'JSXOpeningElement' || n.name?.type !== 'JSXIdentifier') return;
    if (!/^[a-z]/.test(n.name.name)) return;
    if (n.attributes.some((a: Node) => a.name?.name === SOURCE_ATTR)) return;
    s.appendLeft(n.name.end, attr(file, n.loc.start.line, n.loc.start.column + 1));
    changed = true;
  });
  return changed ? s : null;
}

/** Loads a compiler from the project itself, so it always matches the project's version. */
function projectRequire(root: string): NodeJS.Require {
  return createRequire(join(root, 'package.json'));
}

function vue(code: string, file: string, root: string): MagicString | null {
  let compiler: Node;
  try {
    compiler = projectRequire(root)('vue/compiler-sfc');
  } catch {
    return null;
  }
  const { descriptor } = compiler.parse(code, { filename: file });
  const template = descriptor.template;
  // Pug and other template languages are left alone.
  if (!template?.ast || (template.lang && template.lang !== 'html')) return null;
  const s = new MagicString(code);
  let changed = false;
  walk(template.ast, (n) => {
    // Element nodes of type "element" (tagType 0), not components, slots or <template>.
    if (n.type !== 1 || n.tagType !== 0) return;
    if (n.props?.some((p: Node) => p.name === SOURCE_ATTR)) return;
    const at = n.loc.start.offset + 1 + n.tag.length;
    s.appendLeft(at, attr(file, n.loc.start.line, n.loc.start.column));
    changed = true;
  });
  return changed ? s : null;
}

function lineColumn(code: string, offset: number): [number, number] {
  let line = 1;
  let last = -1;
  for (let i = code.indexOf('\n'); i !== -1 && i < offset; i = code.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return [line, offset - last];
}

function svelte(code: string, file: string, root: string): MagicString | null {
  let compiler: Node;
  try {
    compiler = projectRequire(root)('svelte/compiler');
  } catch {
    return null;
  }
  let ast: Node;
  try {
    ast = compiler.parse(code, { modern: true });
  } catch {
    return null;
  }
  const s = new MagicString(code);
  let changed = false;
  walk(ast.fragment, (n) => {
    if (n.type !== 'RegularElement' && n.type !== 'SvelteElement') return;
    if (n.type === 'SvelteElement') return; // <svelte:element this={...}> has no fixed tag.
    if (n.attributes?.some((a: Node) => a.name === SOURCE_ATTR)) return;
    const [line, column] = lineColumn(code, n.start);
    s.appendLeft(n.start + 1 + n.name.length, attr(file, line, column));
    changed = true;
  });
  return changed ? s : null;
}

/** Whether a module id is one of the project's own component files. */
export function wantsFile(id: string): boolean {
  if (id.includes('\0') || id.includes('?') || /[\\/]node_modules[\\/]/.test(id)) return false;
  return /\.(jsx|tsx|vue|svelte)$/.test(id);
}

/**
 * Adds `data-bh-src` to the elements in one file. Returns null when there's
 * nothing to change, so bundlers keep the original.
 */
export function addSourceAttributes(
  code: string,
  id: string,
  root: string,
): TransformResult | null {
  if (!wantsFile(id)) return null;
  const file = relative(root, id).split(sep).join('/');
  if (file.startsWith('..')) return null;
  const ext = extname(id);
  const s =
    ext === '.vue'
      ? vue(code, file, root)
      : ext === '.svelte'
        ? svelte(code, file, root)
        : jsx(code, file, ext === '.tsx');
  if (!s) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ source: id, includeContent: true, hires: true }),
  };
}
