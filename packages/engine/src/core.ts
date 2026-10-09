/**
 * The parts of the engine that run anywhere, with no Playwright and no Node:
 * the width sweep, and turning measurements into issues and breakpoints. The
 * DevTools panel builds its scan from these, so it finds what the CLI finds.
 */
export { DETECTOR_IDS } from '@breakhound/analyzers/types';
export { buildBreakpoints, buildIssues, findingKey, issueId } from './issues';
export { createScanResult, type ResultMeta } from './result';
export { FREEZE_CSS, RESIZE_PROBE, type SweepPage, settleResize } from './settle';
export {
  coarseWidths,
  confirmNarrowIssues,
  type Measurements,
  Sweeper,
  type SweepSettings,
  stateKey,
} from './sweep';
export type * from './types';
