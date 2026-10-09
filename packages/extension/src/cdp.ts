import type { SweepPage } from '@breakhound/engine/core';

/**
 * A Chrome DevTools Protocol connection to one tab. In the panel it is
 * chrome.debugger; in tests it is a Playwright CDP session.
 */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
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

/**
 * Runs `fn(arg)` in the page and returns the result by value, like
 * Playwright's page.evaluate. `fn` must not use anything outside itself.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'The page stopped responding. Keep the tab visible while it scans, since hidden tabs pause.',
          ),
        ),
      timeoutMs,
    );
  });
  try {
    const reply = await Promise.race([
      cdp.send<EvaluateReply>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      timeout,
    ]);
    if (reply.exceptionDetails) {
      const d = reply.exceptionDetails;
      throw new Error(d.exception?.description?.split('\n')[0] ?? d.text ?? 'The page threw');
    }
    return reply.result?.value as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface TabPageOptions {
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
      await setWidth(cdp, width, height);
    },
    evaluate: ((fn: (arg: never) => unknown, arg?: unknown) =>
      evaluate(cdp, fn, arg)) as unknown as SweepPage['evaluate'],
  };
}

/** Lays the tab out at this width, the way Playwright sets a viewport (the screen matches it). */
export async function setWidth(cdp: Cdp, width: number, height: number): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
}
