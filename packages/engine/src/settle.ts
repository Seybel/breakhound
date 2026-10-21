import type { Page, Request } from 'playwright';

/** How long the network has to stay quiet. */
const QUIET_MS = 500;
/**
 * Requests open longer than this are treated as long-lived connections (long
 * polling, streaming, realtime sync) that never finish, so they don't hold up
 * the scan. Playwright's own "networkidle" would wait out its whole timeout.
 */
const LONG_LIVED_MS = 3000;

/** Tracks a page's requests from before navigation, so settling knows what is still loading. */
export class NetworkTracker {
  private readonly open = new Map<Request, number>();
  private lastActivity = Date.now();

  constructor(page: Page) {
    const done = (r: Request) => {
      this.open.delete(r);
      this.lastActivity = Date.now();
    };
    page.on('request', (r) => {
      this.open.set(r, Date.now());
      this.lastActivity = Date.now();
    });
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  private busy(now: number): boolean {
    for (const [request, started] of this.open) {
      const type = request.resourceType();
      if (type === 'websocket' || type === 'eventsource') continue;
      if (now - started < LONG_LIVED_MS) return true;
    }
    return false;
  }

  /** Resolves once nothing short-lived has been loading for a moment, or after `maxMs`. */
  async quiet(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) return;
      if (!this.busy(now) && now - this.lastActivity >= QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * Runs before any page script. Wraps the callbacks that react to viewport
 * changes (window resize, matchMedia change, ResizeObserver) and tracks the
 * timers they schedule, including timers those timers schedule a few levels
 * deep (how debounce helpers re-arm). After a resize we wait exactly until
 * those timers have fired instead of guessing a debounce delay.
 *
 * It can also be added to a page that has already loaded (the extension
 * scanning a page as it is). Listeners added before it aren't wrapped then;
 * `adopt` adds one again, wrapped, as if it had been added after.
 */
export const RESIZE_PROBE = `(() => {
  if (window.__breakhound_settle) return;
  const MAX_DEPTH = 3;
  const MAX_DELAY = 2000;
  let depth = 0;
  let pending = 0;
  let listeners = 0;
  const live = new Map();
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;

  const tracked = (fn, level) => function (...args) {
    const prev = depth;
    depth = level;
    try {
      return typeof fn === 'function' ? fn.apply(this, args) : fn.handleEvent(...args);
    } finally {
      depth = prev;
    }
  };

  window.setTimeout = function (fn, delay, ...args) {
    if (depth === 0 || depth > MAX_DEPTH || typeof fn !== 'function' || (Number(delay) || 0) > MAX_DELAY) {
      return nativeSetTimeout.call(window, fn, delay, ...args);
    }
    pending++;
    let open = true;
    const settle = () => { if (open) { open = false; pending--; } };
    const level = depth + 1;
    const run = tracked(fn, level);
    const id = nativeSetTimeout.call(window, function (...a) {
      live.delete(id);
      try { return run.apply(this, a); } finally { settle(); }
    }, delay, ...args);
    live.set(id, settle);
    return id;
  };
  window.clearTimeout = function (id) {
    const settle = live.get(id);
    if (settle) { live.delete(id); settle(); }
    return nativeClearTimeout.call(window, id);
  };

  const wrappers = new WeakMap();
  const wrapped = new WeakSet();
  const wrap = (listener) => {
    if (!listener) return listener;
    let w = wrappers.get(listener);
    if (!w) { w = tracked(listener, 1); wrappers.set(listener, w); wrapped.add(w); }
    return w;
  };

  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const watched = (target, type) =>
    (target === window && type === 'resize') ||
    (typeof MediaQueryList !== 'undefined' && target instanceof MediaQueryList && type === 'change');
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (watched(this, type) && listener) {
      listeners++;
      return add.call(this, type, wrap(listener), options);
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (watched(this, type) && listener && wrappers.has(listener)) {
      return remove.call(this, type, wrappers.get(listener), options);
    }
    return remove.call(this, type, listener, options);
  };
  if (typeof MediaQueryList !== 'undefined') {
    const legacyAdd = MediaQueryList.prototype.addListener;
    const legacyRemove = MediaQueryList.prototype.removeListener;
    MediaQueryList.prototype.addListener = function (l) { listeners++; return legacyAdd.call(this, wrap(l)); };
    MediaQueryList.prototype.removeListener = function (l) { return legacyRemove.call(this, wrappers.get(l) || l); };
  }
  if (typeof ResizeObserver !== 'undefined') {
    const Native = ResizeObserver;
    window.ResizeObserver = class extends Native {
      constructor(callback) { listeners++; super(tracked(callback, 1)); }
    };
  }

  // A window resize listener added before this script: taken off and added again, wrapped. One set
  // as window.onresize is wrapped where it is.
  const adopt = (listener, capture, passive, once) => {
    // The browser lists a listener added after this script by its wrapper.
    if (!listener || wrappers.has(listener) || wrapped.has(listener)) return;
    if (listener === window.onresize) {
      window.onresize = wrap(listener);
      return;
    }
    remove.call(window, 'resize', listener, capture);
    window.addEventListener('resize', listener, { capture, passive, once });
  };

  Object.defineProperty(window, '__breakhound_settle', {
    value: {
      pending: () => pending,
      listeners: () => listeners + (window.onresize ? 1 : 0),
      adopt,
    },
  });
})();`;

export const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

/** Brings a freshly loaded page to a stable, measurable state. */
export async function settlePage(
  page: Page,
  network: NetworkTracker,
  networkIdleMs: number,
): Promise<void> {
  await page.waitForLoadState('load');
  await network.quiet(networkIdleMs);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(async () => {
    for (const media of document.querySelectorAll('video, audio'))
      (media as HTMLMediaElement).pause();
    // Walk down the page once so lazy content loads, then return to the top.
    // Capped, because an infinite feed grows every time we reach its end.
    const step = window.innerHeight;
    const stopAt = performance.now() + 3000;
    for (
      let y = 0, i = 0;
      y < document.documentElement.scrollHeight && i < 20 && performance.now() < stopAt;
      y += step, i++
    ) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await network.quiet(networkIdleMs);
}

/**
 * The little the width sweep needs from a page. A Playwright page is one; the
 * DevTools panel provides the same over the Chrome DevTools Protocol.
 */
export type SweepPage = Pick<Page, 'setViewportSize' | 'evaluate'>;

/** Waits for the page's own resize handling to finish (see settleAfterResize in the analyzers). */
export async function settleResize(page: SweepPage, maxWaitMs: number): Promise<void> {
  await page.evaluate((maxWait) => window.__breakhound?.settleAfterResize(maxWait), maxWaitMs);
}
