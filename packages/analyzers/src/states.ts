import { closestComposed, DEV_OVERLAYS } from './dom';
import { cachedSelector, resolveSelector } from './selector';
import type { IgnoreRule, Toggle, ToggleKind } from './types';

/**
 * Elements that say they open something, and tabs. Plain buttons are only taken
 * when their name says menu (see MENU_CLASS and MENU_LABEL), because clicking an
 * arbitrary button can do anything.
 */
const CANDIDATES = [
  '[role="tab"]',
  '[aria-expanded]',
  '[aria-haspopup]',
  '[popovertarget]',
  '[commandfor]',
  '[data-bs-toggle]',
  '[data-toggle]',
  'details > summary',
  'button',
  '[role="button"]',
].join(',');

/** Class, id or test id of a menu button: hamburger, navbar-toggler, menu-toggle... */
const MENU_CLASS =
  /(hamburger|burger|navbar-toggler|nav-?toggle|toggle-?nav|menu-?(toggle|button|btn|icon|trigger)|toggle-?menu|mobile-?(menu|nav)-?(toggle|button|btn|trigger)?|drawer-?toggle|sidebar-?toggle|offcanvas-?toggle)/i;
/** Accessible name of a menu button: "Menu", "Open main menu", "Toggle navigation", "☰". */
const MENU_LABEL =
  /^(?:(?:open|toggle|show)\s+)?(?:the\s+)?(?:(?:main|site|mobile|primary)\s+)?(?:menu|navigation|nav|sidebar)(?:\s+menu)?$|^[☰≡]$/i;

const MAX_TOGGLES = 40;

function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  return el.getAttribute('title')?.trim() ?? '';
}

function shortLabel(el: Element, kind: ToggleKind): string {
  const name = nameOf(el);
  // An icon (☰) says nothing in a report; "the menu" does.
  if (!/[\p{L}\p{N}]/u.test(name)) return kind;
  return name.length > 40 ? `${name.slice(0, 37)}...` : name;
}

function targetOf(el: Element, attr: string): Element | null {
  const id = el.getAttribute(attr);
  if (!id) return null;
  return (el.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? null;
}

function bootstrapKind(value: string | null): ToggleKind | null {
  switch (value) {
    case 'modal':
      return 'dialog';
    case 'offcanvas':
    case 'dropdown':
      return 'menu';
    case 'collapse':
      return 'disclosure';
    default:
      return null;
  }
}

function looksLikeMenu(el: Element): boolean {
  const names = [
    typeof el.className === 'string' ? el.className : '',
    el.id,
    el.getAttribute('data-testid') ?? '',
  ].join(' ');
  return MENU_CLASS.test(names) || MENU_LABEL.test(nameOf(el));
}

/** What clicking `el` opens, or null when it isn't something we should click. */
function kindOf(el: Element): ToggleKind | null {
  if (el.matches('details > summary')) {
    const details = el.parentElement as HTMLDetailsElement;
    return details.open || details.querySelector(':scope > summary') !== el ? null : 'details';
  }
  if (el.matches('input, select, textarea, [role="combobox"], [contenteditable]')) return null;
  // The selected tab is what the scan already saw.
  if (el.getAttribute('role') === 'tab')
    return el.getAttribute('aria-selected') === 'true' ? null : 'tab';
  if (el.hasAttribute('popovertarget')) {
    return el.getAttribute('popovertargetaction') === 'hide' ? null : 'popover';
  }
  if (el.hasAttribute('commandfor')) {
    const command = el.getAttribute('command');
    if (command === 'show-modal') return 'dialog';
    if (command === 'toggle-popover' || command === 'show-popover') return 'popover';
    return null;
  }
  const expanded = el.getAttribute('aria-expanded');
  // Already open as the page loads: the scan saw it open.
  if (expanded === 'true') return null;
  const popup = el.getAttribute('aria-haspopup');
  if (popup === 'dialog') return 'dialog';
  if (popup && popup !== 'false') return 'menu';
  const bootstrap = bootstrapKind(
    el.getAttribute('data-bs-toggle') ?? el.getAttribute('data-toggle'),
  );
  if (bootstrap) return bootstrap;
  if (expanded === 'false') return looksLikeMenu(el) ? 'menu' : 'disclosure';
  if (el.matches('button, [role="button"]') && looksLikeMenu(el)) return 'menu';
  return null;
}

/** False for buttons that would submit a form and links that would leave the page. */
function safeToClick(el: Element): boolean {
  if (el.matches(':disabled, [aria-disabled="true"]')) return false;
  if (el instanceof HTMLButtonElement && el.type === 'submit' && el.form) return false;
  // A link to another page leaves this one, even when it also says it opens a menu
  // (top-level nav links that open their dropdown on hover).
  const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
  return !href || href.startsWith('#') || /^javascript:/i.test(href);
}

/** The row that scrolls sideways around `el`, like a tab bar wider than a phone. */
function sidewaysScroller(el: Element): Element | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const { overflowX } = getComputedStyle(p);
    if ((overflowX === 'auto' || overflowX === 'scroll') && p.scrollWidth > p.clientWidth) return p;
  }
  return null;
}

/**
 * Painted, inside the screen's width, and not hidden from people. With `scrolls`, also
 * when scrolled out of sight in a row that scrolls sideways, since clicking scrolls to it.
 */
export function isShown(el: Element, scrolls = false): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if ((r.right <= 0 || r.left >= window.innerWidth) && !(scrolls && sidewaysScroller(el)))
    return false;
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (check && !check.call(el, { opacityProperty: true, visibilityProperty: true })) return false;
  if (!check && getComputedStyle(el).visibility === 'hidden') return false;
  return !el.closest('[aria-hidden="true"], [inert]');
}

function ignored(el: Element, rules: IgnoreRule[]): boolean {
  const marked = closestComposed(el, '[data-breakhound-ignore]');
  if (marked) {
    const scope = (marked.getAttribute('data-breakhound-ignore') ?? '').split(/[\s,]+/);
    if (scope.every((s) => !s) || scope.includes('all') || scope.includes('states')) return true;
  }
  return rules.some((rule) => {
    if (rule.detectors) return false;
    try {
      return Boolean(closestComposed(el, rule.selector));
    } catch {
      return false;
    }
  });
}

/** Toggles that look and sit alike (the questions of an FAQ) need opening only once. */
function groupOf(el: Element, kind: ToggleKind): string {
  const shape = (e: Element | null) =>
    e
      ? `${e.tagName}.${[...e.classList]
          .map((c) => c.replace(/\d+/g, ''))
          .sort()
          .join('.')}`
      : '';
  const panel = targetOf(el, 'aria-controls');
  return `${kind}|${shape(el)}|${shape(el.parentElement)}|${panel ? shape(panel) : ''}`;
}

const PRIORITY: Record<ToggleKind, number> = {
  menu: 0,
  dialog: 0,
  popover: 1,
  tab: 1,
  disclosure: 2,
  details: 3,
};

/** Menus, dialogs, popovers and disclosures that can be opened at this width. */
export function findToggles(rules: IgnoreRule[] = []): Toggle[] {
  const out: Toggle[] = [];
  const panels = new Set<Element>();
  for (const el of document.querySelectorAll(CANDIDATES)) {
    if (out.length >= MAX_TOGGLES) break;
    if (el.closest(DEV_OVERLAYS)) continue;
    const kind = kindOf(el);
    if (!kind || !safeToClick(el) || !isShown(el, kind === 'tab') || ignored(el, rules)) continue;
    // Two buttons for the same panel (an icon and a label) open the same thing.
    const panel = targetOf(el, 'aria-controls') ?? targetOf(el, 'popovertarget');
    if (panel) {
      if (panels.has(panel)) continue;
      panels.add(panel);
    }
    const inHeader = Boolean(el.closest('header, nav, [role="banner"], [role="navigation"]'));
    out.push({
      selector: cachedSelector(el),
      kind,
      label: shortLabel(el, kind),
      // Each tab shows different content, unlike the questions of an FAQ.
      group: kind === 'tab' ? `tab|${cachedSelector(el)}` : groupOf(el, kind),
      priority: PRIORITY[kind] * 2 + (inHeader ? 0 : 1),
    });
  }
  return out;
}

const toggles = new Map<string, Element>();

/**
 * The element a toggle's selector found first in this page load, before it was pressed.
 * Its classes can change once pressed (a selected tab, Bootstrap's `collapsed`), and the
 * selector would then miss it, or find another tab.
 */
function toggleOf(selector: string): Element | null {
  const known = toggles.get(selector);
  if (known?.isConnected) return known;
  const el = resolveSelector(selector);
  if (el) toggles.set(selector, el);
  return el;
}

/**
 * Whether the toggle is on screen, and whether what it controls is open, when
 * the page says so (aria-expanded, details, popovers, dialogs). `open` is null
 * when only looking can tell.
 */
export function toggleState(selector: string): { shown: boolean; open: boolean | null } {
  const el = toggleOf(selector);
  if (!el) return { shown: false, open: null };
  const shown = isShown(el, el.getAttribute('role') === 'tab');
  if (el.matches('details > summary')) {
    return { shown, open: (el.parentElement as HTMLDetailsElement).open };
  }
  if (el.getAttribute('role') === 'tab')
    return { shown, open: el.getAttribute('aria-selected') === 'true' };
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') return { shown, open: expanded === 'true' };
  const target = targetOf(el, 'popovertarget') ?? targetOf(el, 'commandfor');
  if (target instanceof HTMLDialogElement) return { shown, open: target.open };
  if (target?.hasAttribute('popover')) {
    try {
      return { shown, open: target.matches(':popover-open') };
    } catch {
      return { shown, open: null };
    }
  }
  return { shown, open: null };
}

/** Opens or closes a <details> directly; nothing to click. */
export function setDetails(selector: string, open: boolean): void {
  const details = toggleOf(selector)?.parentElement;
  if (details instanceof HTMLDetailsElement) details.open = open;
}

/**
 * Where to click to press the toggle like a person would: its centre, once
 * scrolled into view, provided nothing else sits on top of it there.
 */
export function clickPoint(selector: string): { x: number; y: number } | null {
  const el = toggleOf(selector);
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    r = el.getBoundingClientRect();
  }
  // Scrolls only its own row, never the page sideways.
  const row = r.left < 0 || r.right > window.innerWidth ? sidewaysScroller(el) : null;
  if (row) {
    const box = row.getBoundingClientRect();
    row.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
    r = el.getBoundingClientRect();
  }
  const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return null;
  return hit === el || el.contains(hit) || (el.getRootNode() !== document && hit.contains(el))
    ? { x, y }
    : null;
}

let before: WeakSet<Element> | null = null;

/** Remembers what is on screen before clicking a toggle that doesn't say what it opens. */
export function markShown(): void {
  before = new WeakSet([document.body]);
  for (const el of document.body.querySelectorAll('*')) if (isShown(el)) before.add(el);
}

/**
 * The biggest thing that came on screen since markShown, outside the toggle
 * itself (its icon often swaps to a close icon): the menu or panel it opened.
 */
export function newlyShown(toggle: string): string | null {
  const seen = before;
  before = null;
  if (!seen) return null;
  const trigger = toggleOf(toggle);
  let best: { el: Element; area: number } | null = null;
  for (const el of document.body.querySelectorAll('*')) {
    if (seen.has(el) || (trigger && (trigger === el || trigger.contains(el)))) continue;
    if (el.parentElement && !seen.has(el.parentElement) && isShown(el.parentElement)) continue;
    if (!isShown(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (!best || area > best.area) best = { el, area };
  }
  // A tooltip or a focus ring isn't a menu.
  return best && best.area >= 2000 ? cachedSelector(best.el) : null;
}

export function selectorShown(selector: string): boolean {
  const el = resolveSelector(selector);
  return el ? isShown(el) : false;
}
