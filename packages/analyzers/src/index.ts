import { contentOverflow, mediaOverflow } from './detectors/containment';
import { distortedMedia, smallTapTargets, viewportMeta } from './detectors/elements';
import { overlap } from './detectors/overlap';
import { pageOverflow } from './detectors/page-overflow';
import { clippedText, edgeGutter, squishedText, tinyText } from './detectors/text';
import { wrapStats } from './detectors/wrap';
import { type Snapshot, snapshot } from './dom';
import { declaredBreakpoints, layoutSignature } from './fingerprint';
import { elementOf, selectorFor } from './selector';
import {
  type AnalyzeOptions,
  type AnalyzeResult,
  DETECTOR_IDS,
  type DetectorId,
  type ElementInfo,
  type Finding,
  type IgnoreRule,
} from './types';

export type * from './types';
export { DETECTOR_IDS };

const DETECTORS: Record<Exclude<DetectorId, 'unexpected-wrap'>, (s: Snapshot) => Finding[]> = {
  'page-overflow': pageOverflow,
  'media-overflow': mediaOverflow,
  'content-overflow': contentOverflow,
  overlap,
  'clipped-text': clippedText,
  'squished-text': squishedText,
  'distorted-media': distortedMedia,
  'small-tap-target': smallTapTargets,
  'tiny-text': tinyText,
  'edge-gutter': edgeGutter,
  'viewport-meta': viewportMeta,
};

const IGNORE_ATTR = 'data-breakhound-ignore';
const signatureIds = new WeakMap<Element, string>();

/** Stable per-element key for the layout signature, reused across widths. */
function signatureId(el: Element): string {
  let id = signatureIds.get(el);
  if (!id) {
    id = selectorFor(el);
    signatureIds.set(el, id);
  }
  return id;
}

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
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (!p.hasAttribute(IGNORE_ATTR)) continue;
    const scope = parseDetectors(p.getAttribute(IGNORE_ATTR));
    if (scope === 'all' || scope.has(detector)) return true;
  }
  for (const rule of rules) {
    if (rule.detectors && !rule.detectors.includes(detector)) continue;
    try {
      if (el.closest(rule.selector)) return true;
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

  const findings: Finding[] = [];
  for (const [id, run] of Object.entries(DETECTORS) as [DetectorId, (s: Snapshot) => Finding[]][]) {
    if (!enabled.has(id)) continue;
    for (const f of run(snap)) {
      if (isIgnored(f.element, id, rules) || isIgnored(f.related, id, rules)) continue;
      findings.push(f);
    }
  }

  const wraps = enabled.has('unexpected-wrap')
    ? wrapStats(snap).filter((w) => !isIgnored(w.element, 'unexpected-wrap', rules))
    : [];

  return {
    width: snap.viewportWidth,
    findings,
    wraps,
    signature: layoutSignature(snap, signatureId),
  };
}

export { settleAfterResize } from './settle';
export { declaredBreakpoints };
