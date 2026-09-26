import { analyze, declaredBreakpoints, settleAfterResize } from './index';

declare global {
  interface Window {
    __breakhound?: {
      analyze: typeof analyze;
      declaredBreakpoints: typeof declaredBreakpoints;
      settleAfterResize: typeof settleAfterResize;
    };
  }
}

window.__breakhound = { analyze, declaredBreakpoints, settleAfterResize };
