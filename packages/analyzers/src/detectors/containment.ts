import {
  clipsX,
  contentBox,
  type ElementRecord,
  isInline,
  isVisuallyHidden,
  paintedLeft,
  paintedRight,
  px,
  type Snapshot,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';
import { pick } from './page-overflow';

const TOLERANCE = 1;
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
 * Content escaping a visibly bounded container (card, panel, bordered box).
 * The outermost escaping descendant is blamed, against its nearest bounded ancestor.
 */
export function contentOverflow(snap: Snapshot): Finding[] {
  const bounded = new Set<ElementRecord>();
  for (const rec of snap.records) if (isBounded(rec)) bounded.add(rec);

  const findings: Finding[] = [];
  const escapes = new Map<ElementRecord, ElementRecord>();

  for (const rec of snap.records) {
    if (isVisuallyHidden(rec) || rec.outOfFlow === 'fixed') continue;
    let container = rec.parent;
    while (container && !bounded.has(container)) container = container.parent;
    if (!container || !sameContext(rec, container)) continue;
    if (overflowAmount(rec, container.rect) > TOLERANCE) escapes.set(rec, container);
  }

  for (const [rec, container] of escapes) {
    if (rec.parent && escapes.get(rec.parent) === container) continue;
    const amount = px(overflowAmount(rec, container.rect));
    const textOnly =
      rec.rect.right <= container.rect.right + TOLERANCE &&
      rec.rect.left >= container.rect.left - TOLERANCE;
    findings.push({
      detector: 'content-overflow',
      severity: 'error',
      title: textOnly
        ? `Text spills ${amount}px outside its container`
        : `Content spills ${amount}px outside its container`,
      element: describe(rec.el),
      related: describe(container.el),
      evidence: {
        overflowPx: amount,
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
      related: describe(container.el),
      evidence: {
        overflowPx: px(excess),
        mediaWidth: px(rec.rect.width),
        containerWidth: px(box.width),
      },
      styles: pick(rec.style, ['width', 'min-width', 'max-width', 'height', 'object-fit']),
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
