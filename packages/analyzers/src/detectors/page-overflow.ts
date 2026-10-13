import {
  type ElementRecord,
  isOrnament,
  isVisuallyHidden,
  paintedLeft,
  paintedRight,
  px,
  type Snapshot,
} from '../dom';
import { describe, lineage } from '../selector';
import type { Finding } from '../types';

/** Ignore sub-pixel rounding, but a real 1px horizontal scroll is still a bug. */
const TOLERANCE = 0.5;

/**
 * What stops the content at the viewport edge: the page itself, a full-width
 * wrapper, or the screen (fixed content, such as a modal, never scrolls).
 */
type Edge =
  | { kind: 'root' }
  | { kind: 'screen' }
  | { kind: 'wrapper'; container: ElementRecord; scrolls: boolean };

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
  if (isVisuallyHidden(rec)) return null;
  const right = paintedRight(rec);
  const left = paintedLeft(rec);
  if (right <= snap.viewportWidth + TOLERANCE && left >= -TOLERANCE) return null;
  if (rec.outOfFlow === 'fixed') {
    // Inside its own clipping or scrolling box, the box decides what shows.
    return rec.clipAncestor ? null : { rec, right, left, edge: { kind: 'screen' } };
  }
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
    const clipped =
      edge.kind === 'root' ? snap.rootClipsX : edge.kind === 'screen' || !edge.scrolls;
    const fullyOffscreen = hit.left >= vw || hit.right <= 0;
    // When overflow is hidden, a fully off-screen element is almost always an off-canvas drawer.
    if (clipped && fullyOffscreen) continue;

    const overflowRight = Math.max(0, hit.right - vw);
    const overflowLeft = Math.max(0, -hit.left);
    const side = overflowRight >= overflowLeft ? 'right' : 'left';
    const amount = px(Math.max(overflowRight, overflowLeft));
    if (amount < 1) continue;

    // Content past the start edge can't be scrolled to; past the end edge it adds a scrollbar.
    const endSide = snap.rtl ? 'left' : 'right';
    const scrolls =
      side === endSide &&
      (edge.kind === 'root' ? snap.rootScrollsX : edge.kind === 'wrapper' && edge.scrolls);
    // Decorative shapes bleeding off an edge are intentional unless they cause a scrollbar.
    if (!scrolls && rec.outOfFlow && isDecorative(rec.el)) continue;
    // So is ornamental text (a faint backdrop word), cut off by its wrapper on purpose.
    if (!scrolls && isOrnament(rec)) continue;
    const textOnly = rec.rect.right <= vw + TOLERANCE && rec.rect.left >= -TOLERANCE;

    let title: string;
    if (!scrolls) title = `Content cut off at the ${side} edge by ${amount}px`;
    else if (edge.kind === 'root')
      title = `Page scrolls horizontally (${amount}px wider than the viewport)`;
    else title = `Content scrolls sideways inside a full-width container (${amount}px too wide)`;

    findings.push({
      suggestion: shrinkSuggestion(rec, textOnly),
      detector: 'page-overflow',
      severity: scrolls ? 'error' : 'warning',
      title,
      element: describe(rec.el),
      lineage: lineage(rec.el),
      ...(edge.kind === 'wrapper' ? { related: describe(edge.container.el) } : {}),
      evidence: {
        overflowPx: amount,
        side,
        viewportWidth: vw,
        elementWidth: px(rec.rect.width),
        causedByText: textOnly,
        clippedBy:
          edge.kind === 'root'
            ? snap.rootClipsX
              ? 'page'
              : 'none'
            : edge.kind === 'screen'
              ? 'screen'
              : 'wrapper',
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

/** The longest word of some text, without the punctuation around it. */
function longestWord(text: string): string {
  let longest = '';
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word.length > longest.length) longest = word;
  }
  return longest;
}

/** Names the computed style most likely to stop an element from shrinking. */
export function shrinkSuggestion(rec: ElementRecord, textOnly: boolean): string {
  const s = rec.style;
  if (textOnly) {
    if (s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre') {
      return `white-space: ${s.whiteSpace} keeps this text on one line. Allow it to wrap on small screens.`;
    }
    const word = longestWord(rec.text);
    // An ordinary word that doesn't fit: the text is too big, or the word too long, for here.
    if (word && /^[\p{L}\p{M}'’-]+$/u.test(word)) {
      const size = Number.parseFloat(s.fontSize);
      return size >= 24
        ? `The word "${word}" is wider than the screen at ${Math.round(size)}px. Scale the text down on small screens, for example font-size: clamp(1.75rem, 4vw + 1rem, ${Math.round((size / 16) * 100) / 100}rem).`
        : `The word "${word}" is too long to fit here. Add hyphens: auto (with a lang attribute on the page) or overflow-wrap: break-word.`;
    }
    return 'Long unbreakable text (a URL, email or code). Add overflow-wrap: anywhere to its container.';
  }
  const minWidth = Number.parseFloat(s.minWidth);
  if (minWidth > 0) {
    return `min-width: ${s.minWidth} stops it from shrinking. Lower it or drop it on small screens.`;
  }
  if (s.flexShrink === '0') {
    return 'flex-shrink: 0 stops it from shrinking. Let it shrink, or wrap the row.';
  }
  if (s.whiteSpace === 'nowrap') {
    return 'white-space: nowrap keeps its content on one line. Allow wrapping on small screens.';
  }
  const parent = rec.parent?.style.display ?? '';
  if (parent.includes('flex') || parent.includes('grid')) {
    return 'It is a flex/grid item that will not shrink below its content. Add min-width: 0 to it, or replace its fixed width with max-width: 100%.';
  }
  return 'It is wider than the screen here. Replace any fixed width with max-width: 100% or a fluid width.';
}

const CONTENT_SELECTOR = 'img,video,canvas,iframe,input,button,select,textarea,a[href]';

/** No text and no media or controls: a shape, gradient or background layer. */
export function isDecorative(el: Element): boolean {
  if (el.matches(CONTENT_SELECTOR)) return false;
  if (el.textContent?.trim()) return false;
  if (el.querySelector(CONTENT_SELECTOR)) return false;
  // A web component draws its content in a shadow root we can't see from here.
  if (el.shadowRoot) return false;
  for (const child of el.querySelectorAll('*')) if (child.shadowRoot) return false;
  return true;
}

/** Browser defaults that tell nobody anything about why a layout broke. */
const DEFAULT_VALUES: Record<string, string> = {
  'flex-shrink': '1',
  position: 'static',
  'object-fit': 'fill',
  overflow: 'visible',
  'flex-basis': 'auto',
  transform: 'none',
};

export function pick(style: CSSStyleDeclaration, props: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of props) {
    const v = style.getPropertyValue(prop);
    if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px') continue;
    if (DEFAULT_VALUES[prop] === v) continue;
    out[prop] = v;
  }
  return out;
}
