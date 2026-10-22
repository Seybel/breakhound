import { foldCalendars } from './detectors/calendar';
import { contentOverflow, mediaOverflow } from './detectors/containment';
import { distortedMedia, smallTapTargets, viewportMeta } from './detectors/elements';
import { overlap } from './detectors/overlap';
import { pageOverflow } from './detectors/page-overflow';
import { clippedText, edgeGutter, oversizedText, squishedText, tinyText } from './detectors/text';
import { wrapStats } from './detectors/wrap';
import {
  closestComposed,
  composedParent,
  DEV_OVERLAYS,
  renderedChildren,
  type Snapshot,
  snapshot,
} from './dom';
import { containerSignature, declaredBreakpoints, layoutSignature } from './fingerprint';
import { cachedSelector, describe, elementOf, resolveSelector } from './selector';
import { findToggles } from './states';
import {
  type AnalyzeOptions,
  type AnalyzeResult,
  DETECTOR_IDS,
  type DetectorId,
  type ElementInfo,
  type Finding,
  type IgnoreRule,
} from './types';

export type { HighlightOptions, Region } from './highlight';
export type * from './types';
export { DETECTOR_IDS };

const DETECTORS: Record<
  Exclude<DetectorId, 'unexpected-wrap' | 'calendar' | 'vision'>,
  (s: Snapshot) => Finding[]
> = {
  'page-overflow': pageOverflow,
  'media-overflow': mediaOverflow,
  'content-overflow': contentOverflow,
  overlap,
  'clipped-text': clippedText,
  'squished-text': squishedText,
  'distorted-media': distortedMedia,
  'small-tap-target': smallTapTargets,
  'tiny-text': tinyText,
  'oversized-text': oversizedText,
  'edge-gutter': edgeGutter,
  'viewport-meta': viewportMeta,
};

const IGNORE_ATTR = 'data-breakhound-ignore';

function parseDetectors(value: string | null): Set<string> | 'all' {
  const list = (value ?? '').split(/[\s,]+/).filter(Boolean);
  return list.length === 0 || list.includes('all') ? 'all' : new Set(list);
}

/**
 * True when the element sits inside something the user asked us to ignore,
 * either with a data-breakhound-ignore attribute or a configured selector.
 */
function isIgnored(
  info: ElementInfo | undefined,
  detector: DetectorId,
  rules: IgnoreRule[],
): boolean {
  if (!info) return false;
  const el = elementOf(info);
  if (!el) return false;
  for (let p: Element | null = el; p; p = composedParent(p)) {
    if (!p.hasAttribute(IGNORE_ATTR)) continue;
    const scope = parseDetectors(p.getAttribute(IGNORE_ATTR));
    if (scope === 'all' || scope.has(detector)) return true;
  }
  for (const rule of rules) {
    if (rule.detectors && !rule.detectors.includes(detector)) continue;
    try {
      if (closestComposed(el, rule.selector)) return true;
    } catch {
      // An invalid selector in config shouldn't break the scan.
    }
  }
  return false;
}

export function analyze(options: AnalyzeOptions = {}): AnalyzeResult {
  const enabled = new Set<DetectorId>(options.detectors ?? DETECTOR_IDS);
  const rules = options.ignore ?? [];
  const snap = snapshot();

  let findings: Finding[] = [];
  for (const [id, run] of Object.entries(DETECTORS) as [DetectorId, (s: Snapshot) => Finding[]][]) {
    if (!enabled.has(id)) continue;
    for (const f of run(snap)) {
      if (isIgnored(f.element, id, rules) || isIgnored(f.related, id, rules)) continue;
      findings.push(f);
    }
  }

  if (enabled.has('calendar')) {
    findings = foldCalendars(
      snap,
      findings,
      (root) => !isIgnored(describe(root), 'calendar', rules),
    );
  }

  const wraps = enabled.has('unexpected-wrap')
    ? wrapStats(snap).filter((w) => !isIgnored(w.element, 'unexpected-wrap', rules))
    : [];

  const containers = containerSignature(snap);
  return {
    width: snap.viewportWidth,
    findings,
    wraps,
    signature: layoutSignature(snap, cachedSelector),
    ...(containers ? { containers } : {}),
    ...(options.toggles ? { toggles: findToggles(rules) } : {}),
  };
}

const MEDIA_CONTENT = new Set([
  'IMG',
  'SVG',
  'svg',
  'CANVAS',
  'VIDEO',
  'IFRAME',
  'OBJECT',
  'EMBED',
]);

/** True when the page paints any text or media, including inside shadow roots. */
export function hasContent(): boolean {
  const visit = (el: Element): boolean => {
    if (el.matches(DEV_OVERLAYS)) return false;
    if (MEDIA_CONTENT.has(el.tagName)) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length > 0) return true;
      }
    }
    return renderedChildren(el).some(visit);
  };
  return document.body ? visit(document.body) : false;
}

export { clearHighlights, highlight } from './highlight';
export { findByText } from './selector';
export { settleAfterResize } from './settle';
export {
  clickPoint,
  markShown,
  newlyShown,
  selectorShown,
  setDetails,
  toggleState,
} from './states';
export { declaredBreakpoints, resolveSelector };
