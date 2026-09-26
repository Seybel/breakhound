import type { Page } from 'playwright';

/**
 * Runs before any page script. Counts window resize listeners so we only pay
 * the debounce wait on pages that actually react to resizes in JS.
 */
export const RESIZE_PROBE = `(() => {
  let count = 0;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === 'resize' && this === window) count++;
    return add.call(this, type, ...rest);
  };
  Object.defineProperty(window, '__breakhoundResizeListeners', { get: () => count + (window.onresize ? 1 : 0) });
})();`;

const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

/** Brings a freshly loaded page to a stable, measurable state. */
export async function settlePage(page: Page, networkIdleMs: number): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(async () => {
    for (const media of document.querySelectorAll('video, audio'))
      (media as HTMLMediaElement).pause();
    // Walk down the page once so lazy content loads, then return to the top.
    const step = window.innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => {});
}

/** Waits for layout, media query listeners, ResizeObservers and debounced resize handlers. */
export async function settleResize(page: Page, debounceMs: number): Promise<void> {
  await page.evaluate(async (debounce) => {
    const listeners = (window as unknown as { __breakhoundResizeListeners?: number })
      .__breakhoundResizeListeners;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    if (listeners && debounce > 0) {
      await new Promise((r) => setTimeout(r, debounce));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    window.scrollTo(0, 0);
  }, debounceMs);
}
