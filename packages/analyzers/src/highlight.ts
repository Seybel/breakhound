import { resolveSelector } from './selector';

const OVERLAY_ATTR = 'data-breakhound-overlay';

export interface HighlightOptions {
  selector: string;
  related: string | null;
  /** Draw a dashed line at the right edge of the screen. */
  showEdge: boolean;
  pad: number;
  maxHeight: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function find(selector: string | null): Element | null {
  return selector ? resolveSelector(selector) : null;
}

function overlay(style: Partial<CSSStyleDeclaration>): void {
  const div = document.createElement('div');
  div.setAttribute(OVERLAY_ATTR, '');
  Object.assign(div.style, {
    position: 'absolute',
    zIndex: '2147483647',
    pointerEvents: 'none',
    ...style,
  });
  document.documentElement.appendChild(div);
}

/**
 * Outlines the blamed element (red) and the related one (amber), optionally
 * marks the screen edge, and returns the document region worth capturing.
 */
export function highlight(opts: HighlightOptions): Region | null {
  const target = find(opts.selector);
  if (!target) return null;
  const boxes: { el: Element; color: string }[] = [{ el: target, color: '#e11d48' }];
  const other = find(opts.related);
  if (other && other !== target) boxes.push({ el: other, color: '#f59e0b' });

  const sx = window.scrollX;
  const sy = window.scrollY;
  const vw = document.documentElement.clientWidth;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let right = vw;
  for (const { el, color } of boxes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    top = Math.min(top, r.top + sy);
    bottom = Math.max(bottom, r.bottom + sy);
    right = Math.max(right, r.right + sx);
    overlay({
      left: `${r.left + sx - 2}px`,
      top: `${r.top + sy - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
      outline: `3px solid ${color}`,
      background: `${color}14`,
    });
  }
  if (!Number.isFinite(top)) return null;

  const docHeight = document.documentElement.scrollHeight;
  const y = Math.max(0, top - opts.pad);
  const end = Math.min(docHeight, bottom + opts.pad, y + opts.maxHeight);

  if (opts.showEdge) {
    overlay({
      left: `${vw - 1}px`,
      top: `${y}px`,
      width: '0',
      height: `${end - y}px`,
      borderLeft: '2px dashed #2563eb',
    });
  }
  const scrollWidth = document.documentElement.scrollWidth;
  return {
    x: 0,
    y,
    width: Math.min(Math.max(vw, Math.ceil(right) + 16), Math.max(vw, scrollWidth)),
    height: Math.max(1, end - y),
  };
}

export function clearHighlights(): void {
  for (const el of document.querySelectorAll(`[${OVERLAY_ATTR}]`)) el.remove();
}
