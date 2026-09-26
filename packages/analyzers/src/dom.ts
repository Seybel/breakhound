export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ElementRecord {
  el: Element;
  parent: ElementRecord | null;
  style: CSSStyleDeclaration;
  rect: Box;
  /** Union of this element's own (direct) text nodes, if any. */
  textRect: Box | null;
  /** Number of visual lines taken by the element's own text. */
  textLines: number;
  /** Nearest ancestor that clips horizontal overflow (below the root). */
  clipAncestor: ElementRecord | null;
  /** 'fixed' or 'absolute' if the element or an ancestor is taken out of flow. */
  outOfFlow: 'fixed' | 'absolute' | null;
  /** Nearest ancestor-or-self that is absolutely or fixed positioned. */
  oofRoot: ElementRecord | null;
  /** Region left visible by clipping ancestors; applies to this element's box. */
  clip: Box;
  /** Region left visible for this element's own text and children (adds its own clipping). */
  innerClip: Box;
  depth: number;
}

export const UNCLIPPED: Box = {
  left: -Infinity,
  right: Infinity,
  top: -Infinity,
  bottom: Infinity,
  width: Infinity,
  height: Infinity,
};

export function intersectBox(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function clipFor(rect: Box, style: CSSStyleDeclaration, outer: Box): Box {
  const x = style.overflowX !== 'visible';
  const y = style.overflowY !== 'visible';
  if (!x && !y) return outer;
  const own: Box = {
    left: x ? rect.left : -Infinity,
    right: x ? rect.right : Infinity,
    top: y ? rect.top : -Infinity,
    bottom: y ? rect.bottom : Infinity,
    width: x ? rect.width : Infinity,
    height: y ? rect.height : Infinity,
  };
  return intersectBox(own, outer) ?? { ...rect, right: rect.left, width: 0 };
}

export interface Snapshot {
  viewportWidth: number;
  viewportHeight: number;
  /** html or body clips horizontal overflow, so the page cannot scroll sideways. */
  rootClipsX: boolean;
  /** The document is wider than the viewport. */
  rootScrollsX: boolean;
  scrollWidth: number;
  records: ElementRecord[];
  byElement: Map<Element, ElementRecord>;
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'LINK',
  'META',
  'HEAD',
  'TITLE',
  'BR',
  'WBR',
  'SOURCE',
  'TRACK',
  'OPTION',
  'OPTGROUP',
  'DATALIST',
]);

/**
 * Overlays injected by framework dev servers and devtools. They float over the
 * page, change on their own timers, and are never part of the app's layout.
 */
export const DEV_OVERLAYS = [
  'nextjs-portal',
  '[data-nextjs-toast]',
  '[data-nextjs-dev-tools-button]',
  '#__next-build-watcher',
  '#__next-prerender-indicator',
  '#nuxt-devtools-container',
  '#vue-inspector-container',
  '#__vue-devtools-container__',
  'vite-error-overlay',
  'vite-plugin-checker-error-overlay',
  'astro-dev-toolbar',
  'astro-dev-overlay',
  '#webpack-dev-server-client-overlay',
  '#react-refresh-overlay',
  '.tsqd-parent-container',
  '.TanStackRouterDevtools',
  '#svelte-inspector-host',
  'vercel-live-feedback',
].join(',');

/** Tags whose inner nodes are not layout content we should inspect. */
const LEAF_TAGS = new Set([
  'svg',
  'SVG',
  'MATH',
  'math',
  'SELECT',
  'TEXTAREA',
  'IFRAME',
  'VIDEO',
  'CANVAS',
]);

export function toBox(r: DOMRect | DOMRectReadOnly): Box {
  return {
    left: r.left + window.scrollX,
    right: r.right + window.scrollX,
    top: r.top + window.scrollY,
    bottom: r.bottom + window.scrollY,
    width: r.width,
    height: r.height,
  };
}

export function clipsX(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== 'visible';
}

export function isScrollContainerX(style: CSSStyleDeclaration): boolean {
  return style.overflowX === 'auto' || style.overflowX === 'scroll';
}

function isRendered(el: Element, style: CSSStyleDeclaration): boolean {
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false;
  }
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  return Number.parseFloat(style.opacity) > 0;
}

/** Screen-reader-only patterns: 1px boxes, clip rect(0 0 0 0), clip-path inset(50%). */
export function isVisuallyHidden(rec: ElementRecord): boolean {
  const { style, rect } = rec;
  if (rect.width <= 1 || rect.height <= 1) {
    if (style.overflow !== 'visible' || style.position === 'absolute') return true;
  }
  if (style.clip && style.clip !== 'auto' && /rect\(\s*0/.test(style.clip)) return true;
  if (style.clipPath && /inset\(\s*50%/.test(style.clipPath)) return true;
  return false;
}

function measureOwnText(el: Element): { rect: Box | null; lines: number } {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const lineTops: number[] = [];
  const range = document.createRange();
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width === 0 || r.height === 0) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
      if (!lineTops.some((t) => Math.abs(t - r.top) < r.height / 2)) lineTops.push(r.top);
    }
  }
  if (left === Infinity) return { rect: null, lines: 0 };
  const sx = window.scrollX;
  const sy = window.scrollY;
  return {
    rect: {
      left: left + sx,
      right: right + sx,
      top: top + sy,
      bottom: bottom + sy,
      width: right - left,
      height: bottom - top,
    },
    lines: lineTops.length,
  };
}

/**
 * Walks the rendered DOM once and records geometry plus the inherited layout
 * context every detector needs. Hidden subtrees are skipped entirely.
 */
export function snapshot(): Snapshot {
  const html = document.documentElement;
  const body = document.body;
  const htmlStyle = getComputedStyle(html);
  const bodyStyle = body ? getComputedStyle(body) : htmlStyle;
  const viewportWidth = html.clientWidth;
  const scrollWidth = Math.max(html.scrollWidth, body?.scrollWidth ?? 0);
  const rootClipsX = clipsX(htmlStyle) || clipsX(bodyStyle);

  const records: ElementRecord[] = [];
  const byElement = new Map<Element, ElementRecord>();

  const visit = (el: Element, parent: ElementRecord | null, depth: number) => {
    if (SKIP_TAGS.has(el.tagName) || el.matches(DEV_OVERLAYS)) return;
    const style = getComputedStyle(el);
    if (!isRendered(el, style)) return;
    if (style.display === 'contents') {
      for (const child of el.children) visit(child, parent, depth);
      return;
    }

    const own = LEAF_TAGS.has(el.tagName) ? { rect: null, lines: 0 } : measureOwnText(el);
    let outOfFlow = parent?.outOfFlow ?? null;
    if (style.position === 'fixed') outOfFlow = 'fixed';
    else if (style.position === 'absolute' && outOfFlow !== 'fixed') outOfFlow = 'absolute';

    const positioned = style.position === 'fixed' || style.position === 'absolute';
    const rect = toBox(el.getBoundingClientRect());
    // Fixed elements escape every ancestor clip; everything else inherits it.
    const clip = style.position === 'fixed' ? UNCLIPPED : (parent?.innerClip ?? UNCLIPPED);
    const innerClip = el === document.body || el === html ? clip : clipFor(rect, style, clip);
    const rec: ElementRecord = {
      el,
      parent,
      style,
      rect,
      // Text hidden by the element's own overflow (ellipsis, line-clamp) is not painted.
      textRect:
        own.rect && style.overflowX === 'visible' && style.overflowY === 'visible'
          ? own.rect
          : own.rect && intersectBox(own.rect, innerClip),
      textLines: own.lines,
      clipAncestor:
        parent && parent.el !== body && parent.el !== html && clipsX(parent.style)
          ? parent
          : (parent?.clipAncestor ?? null),
      outOfFlow,
      oofRoot: null,
      clip,
      innerClip,
      depth,
    };
    rec.oofRoot = positioned ? rec : (parent?.oofRoot ?? null);
    records.push(rec);
    byElement.set(el, rec);

    if (LEAF_TAGS.has(el.tagName)) return;
    for (const child of el.children) visit(child, rec, depth + 1);
  };

  if (body) {
    for (const child of body.children) visit(child, null, 1);
  }

  return {
    viewportWidth,
    viewportHeight: html.clientHeight,
    rootClipsX,
    rootScrollsX: !rootClipsX && scrollWidth > viewportWidth,
    scrollWidth,
    records,
    byElement,
  };
}

/** Content box (inside border and padding) of an element record. */
export function contentBox(rec: ElementRecord): Box {
  const s = rec.style;
  const bl = Number.parseFloat(s.borderLeftWidth) || 0;
  const br = Number.parseFloat(s.borderRightWidth) || 0;
  const pl = Number.parseFloat(s.paddingLeft) || 0;
  const pr = Number.parseFloat(s.paddingRight) || 0;
  const left = rec.rect.left + bl + pl;
  const right = rec.rect.right - br - pr;
  return { ...rec.rect, left, right, width: right - left };
}

/** Right-most painted edge of the element, including its own overflowing text. */
export function paintedRight(rec: ElementRecord): number {
  return Math.max(rec.rect.right, rec.textRect?.right ?? -Infinity);
}

export function paintedLeft(rec: ElementRecord): number {
  return Math.min(rec.rect.left, rec.textRect?.left ?? Infinity);
}

export function isInline(style: CSSStyleDeclaration): boolean {
  return style.display === 'inline';
}

export function px(n: number): number {
  return Math.round(n);
}
