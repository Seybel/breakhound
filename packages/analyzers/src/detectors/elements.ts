import {
  type Box,
  type ElementRecord,
  isVisuallyHidden,
  px,
  type Snapshot,
  TOUCH_MAX_WIDTH,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';
import { pick } from './page-overflow';

const MAX_DISTORTION = 0.05;
/** WCAG 2.2 target size (minimum), level AA. */
const MIN_TARGET = 24;
const TARGETS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';

/** Images stretched or squashed out of their natural proportions. */
export function distortedMedia(snap: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const rec of snap.records) {
    if (rec.el.tagName !== 'IMG' || isVisuallyHidden(rec)) continue;
    const img = rec.el as HTMLImageElement;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
    // SVG keeps its own aspect ratio inside a stretched box.
    if (/\.svg(\?|#|$)|^data:image\/svg/i.test(img.currentSrc || img.src)) continue;
    if (rec.style.objectFit && rec.style.objectFit !== 'fill') continue;
    const s = rec.style;
    const w =
      rec.rect.width -
      (Number.parseFloat(s.paddingLeft) || 0) -
      (Number.parseFloat(s.paddingRight) || 0) -
      (Number.parseFloat(s.borderLeftWidth) || 0) -
      (Number.parseFloat(s.borderRightWidth) || 0);
    const h =
      rec.rect.height -
      (Number.parseFloat(s.paddingTop) || 0) -
      (Number.parseFloat(s.paddingBottom) || 0) -
      (Number.parseFloat(s.borderTopWidth) || 0) -
      (Number.parseFloat(s.borderBottomWidth) || 0);
    if (w < 16 || h < 16) continue;
    const natural = img.naturalWidth / img.naturalHeight;
    const rendered = w / h;
    const distortion = Math.abs(rendered / natural - 1);
    if (distortion <= MAX_DISTORTION) continue;
    findings.push({
      detector: 'distorted-media',
      severity: 'warning',
      title: `Image is ${rendered > natural ? 'stretched' : 'squashed'} ${Math.round(distortion * 100)}% out of proportion`,
      element: describe(rec.el),
      evidence: {
        renderedRatio: Math.round(rendered * 100) / 100,
        naturalRatio: Math.round(natural * 100) / 100,
        renderedWidth: px(w),
        renderedHeight: px(h),
      },
      styles: pick(rec.style, ['width', 'height', 'max-width', 'object-fit', 'aspect-ratio']),
      suggestion:
        'Keep width and height proportional (height: auto), or crop with object-fit: cover.',
    });
  }
  return findings;
}

function center(b: Box): { x: number; y: number } {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

function distanceToBox(p: { x: number; y: number }, b: Box): number {
  const dx = Math.max(b.left - p.x, 0, p.x - b.right);
  const dy = Math.max(b.top - p.y, 0, p.y - b.bottom);
  return Math.hypot(dx, dy);
}

/** Links inside running text are exempt from target size rules. */
function isInlineTextLink(rec: ElementRecord): boolean {
  if (rec.el.tagName !== 'A' || !rec.style.display.startsWith('inline')) return false;
  const parent = rec.el.parentElement;
  if (!parent) return false;
  const own = rec.el.textContent?.trim().length ?? 0;
  const around = parent.textContent?.trim().length ?? 0;
  return around > own + 10;
}

function hasLabel(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type !== 'checkbox' && el.type !== 'radio') return false;
  return (el.labels?.length ?? 0) > 0;
}

/**
 * Interactive elements smaller than 24×24px on touch-sized screens, using the
 * WCAG 2.2 spacing exception: an undersized target passes when a 24px circle
 * centred on it doesn't touch any other target.
 */
export function smallTapTargets(snap: Snapshot): Finding[] {
  if (snap.viewportWidth > TOUCH_MAX_WIDTH) return [];
  const targets: ElementRecord[] = [];
  for (const rec of snap.records) {
    if (!rec.el.matches(TARGETS) || isVisuallyHidden(rec)) continue;
    if (rec.el.matches('[disabled], [aria-disabled="true"]')) continue;
    if (rec.rect.width === 0 || rec.rect.height === 0) continue;
    // A target nested in another target (icon inside a button) isn't a separate target.
    let nested = false;
    for (let p = rec.parent; p; p = p.parent) {
      if (p.el.matches(TARGETS)) {
        nested = true;
        break;
      }
    }
    if (!nested) targets.push(rec);
  }

  const findings: Finding[] = [];
  for (const rec of targets) {
    const { width, height } = rec.rect;
    if (width >= MIN_TARGET && height >= MIN_TARGET) continue;
    if (isInlineTextLink(rec) || hasLabel(rec.el)) continue;
    const c = center(rec.rect);
    const crowded = targets.some((other) => {
      if (other === rec) return false;
      if (distanceToBox(c, other.rect) < MIN_TARGET / 2) return true;
      const small = other.rect.width < MIN_TARGET || other.rect.height < MIN_TARGET;
      const oc = center(other.rect);
      return small && Math.hypot(oc.x - c.x, oc.y - c.y) < MIN_TARGET;
    });
    if (!crowded) continue;
    findings.push({
      detector: 'small-tap-target',
      severity: 'warning',
      title: `Tap target is ${px(width)}×${px(height)}px and too close to its neighbours`,
      element: describe(rec.el),
      evidence: { width: px(width), height: px(height), minimum: MIN_TARGET },
      styles: pick(rec.style, ['width', 'height', 'padding', 'font-size', 'gap']),
      suggestion: 'Make it at least 24×24px (44×44px is better for touch), or add space around it.',
    });
  }
  return findings;
}

/** A page without a responsive viewport tag renders at ~980px on phones and shrinks everything. */
export function viewportMeta(): Finding[] {
  const meta = document.querySelector('meta[name="viewport" i]');
  const content = meta?.getAttribute('content')?.replace(/\s+/g, '') ?? '';
  if (/width=device-width/i.test(content)) return [];
  const head = document.head ?? document.documentElement;
  return [
    {
      detector: 'viewport-meta',
      severity: 'error',
      title: meta
        ? 'Viewport meta tag does not use width=device-width'
        : 'Missing the responsive viewport meta tag',
      element: describe(meta ?? head),
      evidence: { content: content || 'missing' },
      styles: {},
      suggestion:
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>. Without it phones render the page at desktop width and shrink it.',
    },
  ];
}
