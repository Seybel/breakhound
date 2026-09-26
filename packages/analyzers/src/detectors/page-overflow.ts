import {
  type ElementRecord,
  isVisuallyHidden,
  paintedLeft,
  paintedRight,
  px,
  type Snapshot,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';

/** Ignore sub-pixel rounding, but a real 1px horizontal scroll is still a bug. */
const TOLERANCE = 0.5;

/** What stops the content at the viewport edge: the page itself, or a full-width wrapper. */
type Edge = { kind: 'root' } | { kind: 'wrapper'; container: ElementRecord; scrolls: boolean };

interface Hit {
  rec: ElementRecord;
  right: number;
  left: number;
  edge: Edge;
}

/** Content that is meant to be scrolled or slid sideways inside its wrapper. */
const SIDEWAYS_CONTENT = new Set(['TABLE', 'PRE', 'CODE']);
const PAGE_CONTENT = 'h1,h2,h3,h4,form,input,textarea,select,main,article';

/**
 * A clipping or scrolling wrapper that spans the whole viewport and holds page
 * content behaves like the page edge: overflow inside it is cut off (or scrolls
 * sideways) exactly where the screen ends. Snap carousels, table wrappers and
 * transform-driven sliders are left alone.
 */
function wrapperEdge(snap: Snapshot, rec: ElementRecord): Edge | null {
  const container = rec.clipAncestor;
  if (!container) return { kind: 'root' };
  const vw = snap.viewportWidth;
  if (container.rect.left > 1 || container.rect.right < vw - 1) return null;
  const cs = container.style;
  if (cs.scrollSnapType && cs.scrollSnapType !== 'none') return null;
  const holdsPage =
    container.rect.height >= snap.viewportHeight / 2 ||
    container.el.querySelector(PAGE_CONTENT) !== null;
  if (!holdsPage) return null;
  for (let p: ElementRecord | null = rec; p && p !== container; p = p.parent) {
    if (SIDEWAYS_CONTENT.has(p.el.tagName)) return null;
    if (p.style.transform && p.style.transform !== 'none') return null;
  }
  return {
    kind: 'wrapper',
    container,
    scrolls: cs.overflowX === 'auto' || cs.overflowX === 'scroll',
  };
}

function sticksOut(snap: Snapshot, rec: ElementRecord): Hit | null {
  if (rec.outOfFlow === 'fixed' || isVisuallyHidden(rec)) return null;
  const right = paintedRight(rec);
  const left = paintedLeft(rec);
  if (right <= snap.viewportWidth + TOLERANCE && left >= -TOLERANCE) return null;
  const edge = wrapperEdge(snap, rec);
  return edge ? { rec, right, left, edge } : null;
}

/**
 * Elements that extend past the viewport edge. When the page (or a full-width
 * layout wrapper) scrolls sideways that's an error; when the overflow is hidden
 * the content is silently cut off instead, which is a warning. Only the
 * outermost offending element in each subtree is blamed.
 */
export function pageOverflow(snap: Snapshot): Finding[] {
  const hits = new Map<ElementRecord, Hit>();
  for (const rec of snap.records) {
    const hit = sticksOut(snap, rec);
    if (hit) hits.set(rec, hit);
  }

  const findings: Finding[] = [];
  for (const hit of hits.values()) {
    const { rec, edge } = hit;
    // Blame the outermost: skip if any ancestor is already sticking out.
    let p = rec.parent;
    let covered = false;
    while (p) {
      if (hits.has(p)) {
        covered = true;
        break;
      }
      p = p.parent;
    }
    if (covered) continue;

    const vw = snap.viewportWidth;
    const clipped = edge.kind === 'root' ? snap.rootClipsX : !edge.scrolls;
    const fullyOffscreen = hit.left >= vw || hit.right <= 0;
    // When overflow is hidden, a fully off-screen element is almost always an off-canvas drawer.
    if (clipped && fullyOffscreen) continue;

    const overflowRight = Math.max(0, hit.right - vw);
    const overflowLeft = Math.max(0, -hit.left);
    const side = overflowRight >= overflowLeft ? 'right' : 'left';
    const amount = px(Math.max(overflowRight, overflowLeft));
    if (amount < 1) continue;

    const scrolls = side === 'right' && (edge.kind === 'root' ? snap.rootScrollsX : edge.scrolls);
    // Decorative shapes bleeding off an edge are intentional unless they cause a scrollbar.
    if (!scrolls && rec.outOfFlow === 'absolute' && isDecorative(rec.el)) continue;
    const textOnly = rec.rect.right <= vw + TOLERANCE && rec.rect.left >= -TOLERANCE;

    let title: string;
    if (!scrolls) title = `Content cut off at the ${side} edge by ${amount}px`;
    else if (edge.kind === 'root')
      title = `Page scrolls horizontally (${amount}px wider than the viewport)`;
    else title = `Content scrolls sideways inside a full-width container (${amount}px too wide)`;

    findings.push({
      detector: 'page-overflow',
      severity: scrolls ? 'error' : 'warning',
      title,
      element: describe(rec.el),
      ...(edge.kind === 'wrapper' ? { related: describe(edge.container.el) } : {}),
      evidence: {
        overflowPx: amount,
        side,
        viewportWidth: vw,
        elementWidth: px(rec.rect.width),
        causedByText: textOnly,
        clippedBy: edge.kind === 'root' ? (snap.rootClipsX ? 'page' : 'none') : 'wrapper',
      },
      styles: pick(rec.style, [
        'width',
        'min-width',
        'max-width',
        'white-space',
        'overflow-wrap',
        'word-break',
        'flex-shrink',
        'position',
        'margin-left',
        'margin-right',
        'transform',
      ]),
    });
  }
  return findings;
}

const CONTENT_SELECTOR = 'img,video,canvas,iframe,input,button,select,textarea,a[href]';

/** No text and no media or controls: a shape, gradient or background layer. */
export function isDecorative(el: Element): boolean {
  if (el.matches(CONTENT_SELECTOR)) return false;
  if (el.textContent?.trim()) return false;
  return !el.querySelector(CONTENT_SELECTOR);
}

export function pick(style: CSSStyleDeclaration, props: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of props) {
    const v = style.getPropertyValue(prop);
    if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') out[prop] = v;
  }
  return out;
}
