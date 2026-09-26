import { contentOverflow, mediaOverflow } from './detectors/containment';
import { overlap } from './detectors/overlap';
import { pageOverflow } from './detectors/page-overflow';
import { wrapStats } from './detectors/wrap';
import { snapshot } from './dom';
import { declaredBreakpoints, layoutSignature } from './fingerprint';
import { selectorFor } from './selector';
import type { AnalyzeOptions, AnalyzeResult, DetectorId, Finding } from './types';

export type * from './types';

const DETECTORS: Record<
  Exclude<DetectorId, 'unexpected-wrap'>,
  (s: ReturnType<typeof snapshot>) => Finding[]
> = {
  'page-overflow': pageOverflow,
  'media-overflow': mediaOverflow,
  'content-overflow': contentOverflow,
  overlap,
};

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

export function analyze(options: AnalyzeOptions = {}): AnalyzeResult {
  const enabled = new Set(options.detectors ?? [...Object.keys(DETECTORS), 'unexpected-wrap']);
  const snap = snapshot();
  const findings: Finding[] = [];
  for (const [id, run] of Object.entries(DETECTORS)) {
    if (enabled.has(id as DetectorId)) findings.push(...run(snap));
  }
  return {
    width: snap.viewportWidth,
    findings,
    wraps: enabled.has('unexpected-wrap') ? wrapStats(snap) : [],
    signature: layoutSignature(snap, signatureId),
  };
}

export { settleAfterResize } from './settle';
export { declaredBreakpoints };
