/**
 * The quick way in: "Scan with breakhound" on the page's right-click menu, and
 * the toolbar icon. Both open the breakhound panel in Chrome's side panel for
 * that tab (extensions can't open DevTools), the menu with a scan already
 * running. The DevTools panel works the same as before.
 */

const MENU_ID = 'breakhound-scan';

/** Pages extensions may debug; Chrome's own pages and the Web Store aren't. */
const PAGES = ['http://*/*', 'https://*/*', 'file:///*'];

/** The panel for one tab; a fresh `scan` value makes an open panel load again and scan. */
export function sidePanelPath(tabId: number, scan: boolean): string {
  return `panel.html?tab=${tabId}${scan ? `&scan=${Date.now()}` : ''}`;
}

function openPanel(tabId: number | undefined, scan: boolean): void {
  if (tabId === undefined || tabId < 0) return;
  // Both calls go out before this click's user gesture ends: Chrome only opens a side panel in response to one.
  chrome.sidePanel
    .setOptions({ tabId, path: sidePanelPath(tabId, scan), enabled: true })
    .catch(() => {});
  chrome.sidePanel.open({ tabId }).catch((error: unknown) => {
    console.warn('breakhound: could not open the side panel', error);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Scan with breakhound',
    contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio', 'editable'],
    documentUrlPatterns: PAGES,
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openPanel(tab?.id, true);
});

chrome.action.onClicked.addListener((tab) => openPanel(tab.id, false));
