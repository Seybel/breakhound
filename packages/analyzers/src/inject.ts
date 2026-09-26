import {
  analyze,
  clearHighlights,
  declaredBreakpoints,
  highlight,
  settleAfterResize,
} from './index';

const api = { analyze, declaredBreakpoints, settleAfterResize, highlight, clearHighlights };

declare global {
  interface Window {
    __breakhound?: typeof api;
  }
}

window.__breakhound = api;
