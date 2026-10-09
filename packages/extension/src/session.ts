import type { Cdp } from './cdp';

/** Why Chrome refused to attach, in words a developer can act on. */
function attachError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/already attached/i.test(message)) {
    return new Error(
      'Another tool is already controlling this tab (another extension, or a test runner). Close it and try again.',
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
 * chrome.debugger attached to the inspected tab. Chrome shows a "breakhound
 * started debugging this browser" bar while it is attached, so the panel only
 * stays attached while it scans or previews a width.
 */
export class TabSession implements Cdp {
  private attached = false;
  /** Called when Chrome or the developer ends the session (the bar's Cancel, the tab closing). */
  onDetach: ((reason: string) => void) | null = null;

  constructor(readonly tabId: number) {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== tabId) return;
      this.attached = false;
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
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }
}
