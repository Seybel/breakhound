import type { SweepPage } from '@breakhound/engine/core';

/**
 * A Chrome DevTools Protocol connection to one tab. In the panel it is
 * chrome.debugger; in tests it is a Playwright CDP session.
 */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Told when measuring has to wait because the tab is hidden (Chrome stops
   * drawing hidden tabs, so nothing settles), and again when it is back.
   */
  onHidden?: ((hidden: boolean) => void) | null;
}

interface EvaluateReply {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Thrown when the developer stops a scan. */
export class Cancelled extends Error {
  constructor() {
    super('Stopped');
  }
}

/** How often a slow answer is checked on: is the tab hidden, or is the page busy? */
const CHECK_EVERY_MS = 2000;

const pause = (ms: number) => new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), ms));

/** Whether the tab is hidden. Unknown (null) when the page is too busy to say. */
async function tabHidden(cdp: Cdp): Promise<boolean | null> {
  const asked = cdp
    .send<EvaluateReply>('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    })
    .then((r) => r.result?.value === 'hidden')
    .catch(() => null);
  return Promise.race([asked, pause(1000).then(() => null)]);
}

/**
 * Runs `fn(arg)` in the page and returns the result by value, like
 * Playwright's page.evaluate. `fn` must not use anything outside itself.
 *
 * It gives up once the page has been visible and silent for `timeoutMs`.
 * While the tab is hidden it waits as long as it takes, since a hidden tab
 * draws nothing and measuring carries on by itself once it is shown again.
 */
export async function evaluate<T>(
  cdp: Cdp,
  fn: ((arg: never) => unknown) | string,
  arg?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const expression =
    typeof fn === 'string'
      ? fn
      : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
  const sent = cdp.send<EvaluateReply>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  // After giving up nobody waits for the reply any more; a late failure isn't an error then.
  sent.catch(() => {});
  let silentFor = 0;
  let hidden = false;
  try {
    for (;;) {
      const step = Math.min(CHECK_EVERY_MS, timeoutMs);
      const reply = await Promise.race([sent, pause(step)]);
      if (reply !== 'waiting') {
        if (reply.exceptionDetails) {
          const d = reply.exceptionDetails;
          throw new Error(d.exception?.description?.split('\n')[0] ?? d.text ?? 'The page threw');
        }
        return reply.result?.value as T;
      }
      const nowHidden = await tabHidden(cdp);
      if (nowHidden) {
        if (!hidden) cdp.onHidden?.(true);
        hidden = true;
        silentFor = 0;
        continue;
      }
      if (hidden && nowHidden === false) {
        hidden = false;
        cdp.onHidden?.(false);
      }
      silentFor += step;
      if (silentFor >= timeoutMs) {
        throw new Error(
          'The page stopped responding: it was busy for too long, paused in the debugger, or showing a dialog.',
        );
      }
    }
  } finally {
    if (hidden) cdp.onHidden?.(false);
  }
}

/** The space the tab really has, so wider widths can be zoomed out to fit in it. */
export interface Viewport {
  width: number;
  height: number;
}

export interface TabPageOptions {
  /** Zoom widths wider than this out to fit, so the whole layout stays in view. */
  fit?: Viewport;
  /** Called with every width the page is set to. */
  onResize?: (width: number) => void;
  /** Checked before every resize; true stops the scan. */
  cancelled?: () => boolean;
}

/** The page the engine's sweep drives, here backed by device emulation in the tab. */
export function tabPage(cdp: Cdp, options: TabPageOptions = {}): SweepPage {
  return {
    async setViewportSize({ width, height }) {
      if (options.cancelled?.()) throw new Cancelled();
      options.onResize?.(width);
      await setWidth(cdp, width, height, options.fit);
    },
    evaluate: ((fn: (arg: never) => unknown, arg?: unknown) =>
      evaluate(cdp, fn, arg)) as unknown as SweepPage['evaluate'],
  };
}

/** How far a width has to be zoomed out to fit the tab's own space. */
export function fitScale(width: number, fit?: Viewport): number {
  return fit && width > fit.width ? fit.width / width : 1;
}

/**
 * Lays the tab out at this width, the way Playwright sets a viewport (the
 * screen matches it). Wider than the tab, it is zoomed out to fit, like
 * DevTools' device mode; that changes how it looks, not how it lays out.
 * A height of 0 fills the tab's height.
 */
export async function setWidth(
  cdp: Cdp,
  width: number,
  height: number,
  fit?: Viewport,
): Promise<void> {
  const scale = fitScale(width, fit);
  const h = height || (fit ? Math.round(fit.height / scale) : 0);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: h,
    deviceScaleFactor: 0,
    mobile: false,
    screenWidth: width,
    screenHeight: h,
    ...(scale < 1 ? { scale } : {}),
  });
}
