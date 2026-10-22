/**
 * Tells the developer, wherever they are, when their agent's check waits on this tab. Chrome
 * draws nothing in a tab that's out of view, so the check can't go on until it's back, and the
 * developer is usually in their editor by then. A desktop notification reaches them there, and
 * clicking it brings the tab forward.
 *
 * Notifications are an optional permission, asked for once when the developer first sends a
 * scan to their agent, so breakhound never needs them to work.
 */

const ASKED_KEY = 'breakhound.notifications-asked';

const idFor = (tabId: number) => `breakhound-waiting-${tabId}`;

/** Asks once to show notifications. Chrome only asks during a click, so call it in one. */
export function askToNotify(): void {
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    return;
  }
  chrome.permissions.request({ permissions: ['notifications'] }).catch(() => {});
}

let listening = false;
const shown = new Set<number>();

/** Brings the tab, and its window, to the front. */
async function bringForward(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

export function showWaiting(tabId: number, page: string): void {
  const notifications = chrome.notifications;
  if (!notifications) return;
  if (!listening) {
    listening = true;
    notifications.onClicked.addListener((id) => {
      for (const tab of shown) {
        if (id !== idFor(tab)) continue;
        void bringForward(tab).catch(() => {});
        clearWaiting(tab);
      }
    });
  }
  shown.add(tabId);
  notifications
    .create(idFor(tabId), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'Your agent is waiting on Chrome',
      message: `breakhound is checking your agent's fixes on ${page}, in a tab that's out of view, and Chrome doesn't draw those. Click to bring it back; the check carries on by itself.`,
      requireInteraction: true,
    })
    .catch(() => {});
}

export function clearWaiting(tabId: number): void {
  if (!shown.delete(tabId)) return;
  chrome.notifications?.clear(idFor(tabId)).catch(() => {});
}
