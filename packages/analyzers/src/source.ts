import type { SourceLocation } from './types';

/**
 * Where an element is written in the project's code, from what dev builds
 * leave on the page:
 *
 * 1. `data-bh-src="src/Nav.tsx:42:7"`, added by breakhound's build plugins.
 * 2. React's dev info on the element's fiber: the exact line in React 18,
 *    the component and its file in React 19.
 * 3. Vue's dev info: the file of the component that renders the element.
 * 4. The nearest ancestor with `data-bh-src`, for elements rendered by a
 *    library component (its usage site is the place to fix).
 *
 * Paths can come back absolute or as a dev server URL path; the CLI makes
 * them relative to the project.
 */

export const SOURCE_ATTR = 'data-bh-src';

// biome-ignore lint/suspicious/noExplicitAny: framework internals are untyped.
type Any = any;

function fromAttribute(value: string, exact: boolean): SourceLocation | null {
  const m = value.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
  if (!m?.[1]) return null;
  return {
    file: m[1],
    ...(m[2] ? { line: Number(m[2]) } : {}),
    ...(m[3] ? { column: Number(m[3]) } : {}),
    exact,
  };
}

/** Frames from libraries, bundler runtimes and React itself say nothing about the app's code. */
const NOT_APP_CODE =
  /node_modules|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh|\/_next\/static\/chunks\/|react-dom|jsx-dev-runtime|react-stack/;

/** The first stack frame in the app's own code, as a path (without line: the served code is transformed). */
export function fileFromStack(stack: string): string | null {
  for (const line of stack.split('\n')) {
    const m = line.match(/((?:https?|file):\/\/[^\s)]+|webpack-internal:\/\/\/[^\s)]+):\d+:\d+/);
    const url = m?.[1];
    if (!url || NOT_APP_CODE.test(url)) continue;
    if (url.startsWith('webpack-internal:')) {
      const path = url.match(/\/\.\/(.+)$/)?.[1];
      if (path) return path.split('?')[0] ?? null;
      continue;
    }
    try {
      const u = new URL(url);
      return u.protocol === 'file:' ? decodeURIComponent(u.pathname) : u.pathname;
    } catch {
      // Not a URL after all.
    }
  }
  return null;
}

function componentName(type: Any): string | undefined {
  if (!type) return undefined;
  if (typeof type === 'function') return type.displayName || type.name || undefined;
  // memo() and forwardRef() wrap the real component.
  return type.displayName || componentName(type.type) || componentName(type.render);
}

function reactSource(el: Element): SourceLocation | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  const fiber: Any = key ? (el as Any)[key] : null;
  if (!fiber) return null;
  const owner = fiber._debugOwner;
  const component = componentName(owner?.type);
  const debug = fiber._debugSource;
  if (debug?.fileName && !NOT_APP_CODE.test(debug.fileName)) {
    return {
      file: debug.fileName,
      ...(debug.lineNumber ? { line: debug.lineNumber } : {}),
      ...(debug.columnNumber ? { column: debug.columnNumber } : {}),
      ...(component ? { component } : {}),
      exact: true,
    };
  }
  const stack = fiber._debugStack;
  const text = typeof stack === 'string' ? stack : stack?.stack;
  const file = typeof text === 'string' ? fileFromStack(text) : null;
  return file ? { file, ...(component ? { component } : {}), exact: false } : null;
}

function vueSource(el: Element): SourceLocation | null {
  for (let instance: Any = (el as Any).__vueParentComponent; instance; instance = instance.parent) {
    const file: unknown = instance.type?.__file;
    if (typeof file === 'string' && !NOT_APP_CODE.test(file)) {
      const component = instance.type.__name || instance.type.name;
      return { file, ...(component ? { component } : {}), exact: false };
    }
  }
  return null;
}

export function sourceOf(el: Element): SourceLocation | null {
  try {
    const own = el.getAttribute(SOURCE_ATTR);
    if (own) return fromAttribute(own, true);
    const found = reactSource(el) ?? vueSource(el);
    if (found) return found;
    const above = el.parentElement?.closest(`[${SOURCE_ATTR}]`);
    const value = above?.getAttribute(SOURCE_ATTR);
    return value ? fromAttribute(value, false) : null;
  } catch {
    return null;
  }
}
