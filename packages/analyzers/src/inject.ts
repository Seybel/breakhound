import { analyze, declaredBreakpoints } from './index';

declare global {
  interface Window {
    __breakhound?: { analyze: typeof analyze; declaredBreakpoints: typeof declaredBreakpoints };
  }
}

window.__breakhound = { analyze, declaredBreakpoints };
