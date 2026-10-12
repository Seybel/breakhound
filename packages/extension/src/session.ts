import type { Cdp } from './cdp';

/** Why Chrome refused to attach, in words a developer can act on. */
function attachError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/already attached/i.test(message)) {
    return new Error(
      'Something else is already controlling this tab: breakhound open in another view (DevTools or the side panel), another extension, or a test runner. Close it and try again.',
    );
  }
  if (/chrome:\/\/|chrome-extension:\/\/|webstore|Cannot access/i.test(message)) {
    return new Error(
      "Chrome doesn't let extensions measure this page. Open your site in the tab and try again.",
    );
  }
  if (/file:\/\//i.test(message)) {
    return new Error(
      'To scan a file:// page, turn on "Allow access to file URLs" for breakhound in chrome://extensions.',
    );
  }
  return new Error(message);
}

/**
 * What breakhound leaves in a page while attached: outlines around an issue, and the style that
 * freezes animations during a scan. Removing them goes through the debugger too, so when the
 * developer cancels the debugging bar they would stay. The page cleans up after itself instead:
 * the panel checks in every second, and once it hasn't for a few seconds while the page itself was
 * free to notice, the page takes them away.
 */
export const LEFTOVERS = '[data-breakhound-overlay], style[data-breakhound-freeze]';
const CHECK_IN = `(() => {
  const w = window;
  w.__breakhoundSeen = Date.now();
  if (w.__breakhoundGuard) return;
  let missed = 0;
  w.__breakhoundGuard = setInterval(() => {
    if (Date.now() - w.__breakhoundSeen < 2500) { missed = 0; return; }
    // Twice in a row, so a page that was busy, which delays the check-in too, isn't mistaken for one left alone.
    if (++missed < 2) return;
    clearInterval(w.__breakhoundGuard);
    w.__breakhoundGuard = 0;
    for (const el of document.querySelectorAll(${JSON.stringify(LEFTOVERS)})) el.remove();
  }, 1000);
})()`;

/**
 * chrome.debugger attached to the inspected tab. Chrome shows a "breakhound
 * started debugging this browser" bar while it is attached, so the panel only
 * stays attached while it scans or previews a width.
 */
export class TabSession implements Cdp {
  private attached = false;
  private checkIns: ReturnType<typeof setInterval> | undefined;
  /** Called when Chrome or the developer ends the session (the bar's Cancel, the tab closing). */
  onDetach: ((reason: string) => void) | null = null;
  onHidden: ((hidden: boolean) => void) | null = null;

  constructor(readonly tabId: number) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== tabId) return;
      this.attached = false;
      clearInterval(this.checkIns);
      this.onDetach?.(reason);
    });
  }

  get isAttached(): boolean {
    return this.attached;
  }

  async attach(): Promise<void> {
    if (this.attached) return;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    } catch (error) {
      throw attachError(error);
    }
    this.attached = true;
    const checkIn = () => this.send('Runtime.evaluate', { expression: CHECK_IN }).catch(() => {});
    void checkIn();
    this.checkIns = setInterval(checkIn, 1000);
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    clearInterval(this.checkIns);
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }
}
