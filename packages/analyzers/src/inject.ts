import {
  analyze,
  clearHighlights,
  declaredBreakpoints,
  hasContent,
  highlight,
  resolveSelector,
  settleAfterResize,
} from './index';

const api = {
  analyze,
  declaredBreakpoints,
  settleAfterResize,
  highlight,
  clearHighlights,
  hasContent,
  resolveSelector,
};

declare global {
  interface Window {
    __breakhound?: typeof api;
  }
}

window.__breakhound = api;
