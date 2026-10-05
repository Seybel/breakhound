import {
  analyze,
  clearHighlights,
  clickPoint,
  declaredBreakpoints,
  findByText,
  hasContent,
  highlight,
  markShown,
  newlyShown,
  resolveSelector,
  selectorShown,
  setDetails,
  settleAfterResize,
  toggleState,
} from './index';

const api = {
  analyze,
  declaredBreakpoints,
  settleAfterResize,
  highlight,
  clearHighlights,
  hasContent,
  resolveSelector,
  toggleState,
  setDetails,
  clickPoint,
  markShown,
  newlyShown,
  selectorShown,
  findByText,
};

declare global {
  interface Window {
    __breakhound?: typeof api;
  }
}

window.__breakhound = api;
