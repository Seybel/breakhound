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

interface Hit {
  rec: ElementRecord;
  right: number;
  left: number;
}

function sticksOut(snap: Snapshot, rec: ElementRecord): Hit | null {
  if (rec.outOfFlow === 'fixed' || rec.clipAncestor || isVisuallyHidden(rec)) return null;
  const right = paintedRight(rec);
  const left = paintedLeft(rec);
  if (right > snap.viewportWidth + TOLERANCE || left < -TOLERANCE) return { rec, right, left };
  return null;
}

/**
 * Elements that extend past the viewport edge. When the page can scroll
 * sideways that's an error; when html/body hide the overflow the content is
 * silently cut off instead, which is reported as a warning. Only the outermost
 * offending element in each subtree is blamed.
 */
export function pageOverflow(snap: Snapshot): Finding[] {
  const hits = new Map<ElementRecord, Hit>();
  for (const rec of snap.records) {
    const hit = sticksOut(snap, rec);
    if (hit) hits.set(rec, hit);
  }

  const findings: Finding[] = [];
  for (const hit of hits.values()) {
    const { rec } = hit;
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
    const fullyOffscreen = hit.left >= vw || hit.right <= 0;
    // With clipped root, a fully off-screen element is almost always an off-canvas drawer.
    if (snap.rootClipsX && fullyOffscreen) continue;

    const overflowRight = Math.max(0, hit.right - vw);
    const overflowLeft = Math.max(0, -hit.left);
    const side = overflowRight >= overflowLeft ? 'right' : 'left';
    const amount = px(Math.max(overflowRight, overflowLeft));
    if (amount < 1) continue;

    const scrolls = snap.rootScrollsX && side === 'right';
    // Decorative shapes bleeding off an edge are intentional unless they cause a scrollbar.
    if (!scrolls && rec.outOfFlow === 'absolute' && isDecorative(rec.el)) continue;
    const textOnly = rec.rect.right <= vw + TOLERANCE && rec.rect.left >= -TOLERANCE;

    findings.push({
      detector: 'page-overflow',
      severity: scrolls ? 'error' : 'warning',
      title: scrolls
        ? `Page scrolls horizontally (${amount}px wider than the viewport)`
        : `Content cut off at the ${side} edge by ${amount}px`,
      element: describe(rec.el),
      evidence: {
        overflowPx: amount,
        side,
        viewportWidth: vw,
        elementWidth: px(rec.rect.width),
        causedByText: textOnly,
        rootClipsX: snap.rootClipsX,
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
