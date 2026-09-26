import {
  clipsX,
  contentBox,
  type ElementRecord,
  isDeliberateOffset,
  isInline,
  isVisuallyHidden,
  paintedLeft,
  paintedRight,
  px,
  type Snapshot,
} from '../dom';
import { describe, lineage } from '../selector';
import type { Finding } from '../types';
import { pick, shrinkSuggestion } from './page-overflow';

const TOLERANCE = 1;
/** Below this a spill is sub-pixel rounding or a descender. */
const VERTICAL_TOLERANCE = 2;
const MEDIA = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS', 'EMBED', 'OBJECT', 'svg', 'PICTURE']);

function alpha(color: string): number {
  if (!color || color === 'transparent') return 0;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m?.[1]) return 1;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? Number.parseFloat(parts[3] ?? '1') : 1;
}

function effectiveBackground(rec: ElementRecord | null): string {
  let p = rec;
  while (p) {
    if (alpha(p.style.backgroundColor) > 0) return p.style.backgroundColor;
    p = p.parent;
  }
  const body = getComputedStyle(document.body).backgroundColor;
  if (alpha(body) > 0) return body;
  return getComputedStyle(document.documentElement).backgroundColor;
}

/** Has a boundary a user can see: border, shadow, image, or a distinct background. */
function isBounded(rec: ElementRecord): boolean {
  const s = rec.style;
  if (clipsX(s) || isInline(s) || rec.rect.width < 24 || rec.rect.height < 16) return false;
  const border =
    (Number.parseFloat(s.borderLeftWidth) > 0 && alpha(s.borderLeftColor) > 0) ||
    (Number.parseFloat(s.borderRightWidth) > 0 && alpha(s.borderRightColor) > 0);
  if (border) return true;
  if (s.boxShadow && s.boxShadow !== 'none') return true;
  if (s.backgroundImage && s.backgroundImage !== 'none') return true;
  const bg = s.backgroundColor;
  return alpha(bg) > 0 && bg !== effectiveBackground(rec.parent);
}

function sameContext(a: ElementRecord, b: ElementRecord): boolean {
  return a.oofRoot === b.oofRoot && a.clipAncestor === b.clipAncestor;
}

function overflowAmount(child: ElementRecord, box: { left: number; right: number }): number {
  return Math.max(paintedRight(child) - box.right, box.left - paintedLeft(child), 0);
}

/**
 * How far a block spills past the bottom border of its container. In-flow
 * content can only do that when the container's height is fixed. Inline boxes
 * are left to their block, because glyphs legitimately poke out of a tight
 * line-height.
 */
function overflowBelow(child: ElementRecord, container: ElementRecord): number {
  if (isInline(child.style)) return 0;
  return Math.max(child.rect.bottom - container.rect.bottom, 0);
}

/** Something between the element and its container moves it out of place on purpose. */
function offsetOnPurpose(rec: ElementRecord, container: ElementRecord): boolean {
  for (let p: ElementRecord | null = rec; p && p !== container; p = p.parent) {
    if (isDeliberateOffset(p) || p.style.float !== 'none') return true;
  }
  return false;
}

interface Escape {
  container: ElementRecord;
  side: 'right' | 'left' | 'bottom';
  amount: number;
}

/**
 * Content escaping a visibly bounded container (card, panel, bordered box),
 * sideways or out of the bottom of a fixed-height box. The outermost escaping
 * descendant is blamed, against its nearest bounded ancestor.
 */
export function contentOverflow(snap: Snapshot): Finding[] {
  const bounded = new Set<ElementRecord>();
  for (const rec of snap.records) if (isBounded(rec)) bounded.add(rec);

  const findings: Finding[] = [];
  const escapes = new Map<ElementRecord, Escape>();

  for (const rec of snap.records) {
    if (isVisuallyHidden(rec) || rec.outOfFlow === 'fixed') continue;
    let container = rec.parent;
    while (container && !bounded.has(container)) container = container.parent;
    if (!container || !sameContext(rec, container)) continue;
    const sideways = overflowAmount(rec, container.rect);
    if (sideways > TOLERANCE) {
      const side = paintedRight(rec) - container.rect.right >= sideways - 0.01 ? 'right' : 'left';
      escapes.set(rec, { container, side, amount: sideways });
      continue;
    }
    const below = overflowBelow(rec, container);
    if (below > VERTICAL_TOLERANCE && !offsetOnPurpose(rec, container)) {
      escapes.set(rec, { container, side: 'bottom', amount: below });
    }
  }

  for (const [rec, { container, side, amount: raw }] of escapes) {
    if (rec.parent && escapes.get(rec.parent)?.container === container) continue;
    const amount = px(raw);
    if (side === 'bottom') {
      findings.push({
        detector: 'content-overflow',
        severity: 'error',
        title: `Content spills ${amount}px out of the bottom of its container`,
        element: describe(rec.el),
        related: describe(container.el),
        evidence: {
          overflowPx: amount,
          side,
          containerHeight: px(container.rect.height),
          elementHeight: px(rec.rect.height),
        },
        styles: pick(container.style, ['height', 'max-height', 'min-height']),
        suggestion: `The container is ${px(container.rect.height)}px tall and its content needs more room at this width. Use min-height instead of a fixed height.`,
      });
      continue;
    }
    const textOnly =
      rec.rect.right <= container.rect.right + TOLERANCE &&
      rec.rect.left >= container.rect.left - TOLERANCE;
    findings.push({
      suggestion: shrinkSuggestion(rec, textOnly),
      detector: 'content-overflow',
      severity: 'error',
      title: textOnly
        ? `Text spills ${amount}px outside its container`
        : `Content spills ${amount}px outside its container`,
      element: describe(rec.el),
      lineage: lineage(rec.el),
      related: describe(container.el),
      evidence: {
        overflowPx: amount,
        side,
        containerWidth: px(container.rect.width),
        elementWidth: px(rec.rect.width),
        causedByText: textOnly,
      },
      styles: pick(rec.style, [
        'width',
        'min-width',
        'white-space',
        'overflow-wrap',
        'word-break',
        'flex-shrink',
        'flex-basis',
      ]),
    });
  }
  return findings;
}

function isMedia(el: Element): boolean {
  return MEDIA.has(el.tagName);
}

/** Images, video and embeds that don't shrink to fit their container. */
export function mediaOverflow(snap: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const rec of snap.records) {
    if (!isMedia(rec.el) || rec.outOfFlow) continue;
    if (rec.el.tagName === 'PICTURE') continue; // its <img> is checked instead
    let container = rec.parent;
    while (container && (isInline(container.style) || container.el.tagName === 'PICTURE')) {
      container = container.parent;
    }
    if (!container || container.clipAncestor !== rec.clipAncestor || clipsX(container.style))
      continue;

    const ml = Number.parseFloat(rec.style.marginLeft) || 0;
    const mr = Number.parseFloat(rec.style.marginRight) || 0;
    if (ml < 0 || mr < 0) continue; // deliberate full-bleed breakout

    const box = contentBox(container);
    const excess = rec.rect.width - box.width;
    if (excess <= TOLERANCE || rec.rect.right <= box.right + TOLERANCE) continue;

    findings.push({
      detector: 'media-overflow',
      severity: 'error',
      title: `${label(rec.el)} is ${px(excess)}px wider than its container`,
      element: describe(rec.el),
      lineage: lineage(rec.el),
      related: describe(container.el),
      evidence: {
        overflowPx: px(excess),
        mediaWidth: px(rec.rect.width),
        containerWidth: px(box.width),
      },
      styles: pick(rec.style, ['width', 'min-width', 'max-width', 'height', 'object-fit']),
      suggestion: 'Add max-width: 100% and height: auto so it scales down with its container.',
    });
  }
  return findings;
}

function label(el: Element): string {
  switch (el.tagName) {
    case 'IMG':
      return 'Image';
    case 'VIDEO':
      return 'Video';
    case 'IFRAME':
    case 'EMBED':
    case 'OBJECT':
      return 'Embed';
    case 'CANVAS':
      return 'Canvas';
    default:
      return 'Graphic';
  }
}
