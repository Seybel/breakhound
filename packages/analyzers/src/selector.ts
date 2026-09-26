import { composedParent } from './dom';
import type { ElementInfo } from './types';

const cache = new WeakMap<Element, ElementInfo>();
const owners = new WeakMap<ElementInfo, Element>();

/** The element an ElementInfo was created for (used to apply ignore rules). */
export function elementOf(info: ElementInfo): Element | undefined {
  return owners.get(info);
}

/** ids that look generated (React useId, Radix, Headless UI, numeric suffixes). */
function isStableId(id: string): boolean {
  if (!id || /[:«»]/.test(id)) return false;
  if (/^(radix|headlessui|react-aria|mui|chakra|ember)[-_]/i.test(id)) return false;
  if (/\d{3,}/.test(id)) return false;
  return /^[A-Za-z][\w-]*$/.test(id);
}

/**
 * Classes worth using in a selector: skip CSS-in-JS hashes and Tailwind
 * variants/arbitrary values, which are noisy and often non-unique.
 */
function usefulClasses(el: Element): string[] {
  const out: string[] = [];
  for (const c of el.classList) {
    if (/[:[\]/!@.%#()]/.test(c)) continue;
    if (/^(css|sc|jsx|emotion|svelte|astro|styled)-[\w-]*\d/i.test(c)) continue;
    if (/^_?[a-zA-Z]+_[a-zA-Z0-9]+__[\w-]{4,}$/.test(c)) continue; // CSS modules
    if (/^[a-z]{1,3}[A-Z0-9]\w{4,}$/.test(c) && /\d/.test(c)) continue;
    out.push(c);
  }
  // Prefer semantic-looking names (contain a dash or are long) over short utilities.
  return out.sort((a, b) => score(b) - score(a)).slice(0, 2);
}

function score(c: string): number {
  let s = c.length;
  if (/^(flex|grid|block|inline|hidden|p[trblxy]?-|m[trblxy]?-|w-|h-|text-|bg-|gap-)/.test(c))
    s -= 20;
  return s;
}

function cssEscape(s: string): string {
  return CSS.escape(s);
}

function segment(el: Element, withClasses: boolean, withNth: boolean): string {
  let s = el.tagName.toLowerCase();
  if (withClasses)
    s += usefulClasses(el)
      .map((c) => `.${cssEscape(c)}`)
      .join('');
  if (withNth) {
    const siblings = el.parentElement?.children ?? el.parentNode?.children;
    const same = Array.from(siblings ?? []).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

type Root = Document | ShadowRoot;

function isUnique(selector: string, el: Element, root: Root): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Separates the host's selector from the selector inside its shadow root. */
export const SHADOW_SEPARATOR = ' >>> ';

/** Shortest unique selector for `el` within its own document or shadow root. */
function selectorWithin(el: Element, root: Root): string {
  if (el.id && isStableId(el.id) && isUnique(`#${cssEscape(el.id)}`, el, root))
    return `#${cssEscape(el.id)}`;

  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    if (current !== el && current.id && isStableId(current.id)) {
      parts.unshift(`#${cssEscape(current.id)}`);
      const candidate = parts.join(' > ');
      if (isUnique(candidate, el, root)) return candidate;
      parts.shift();
    }
    // Try the cheapest segment that makes the chain unique.
    for (const [cls, nth] of [
      [true, false],
      [true, true],
    ] as const) {
      const candidate = [segment(current, cls, nth), ...parts].join(' > ');
      if (isUnique(candidate, el, root)) return candidate;
    }
    parts.unshift(segment(current, true, true));
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/**
 * A selector that finds `el` again. Inside a shadow root it is the host's
 * selector and the inner selector joined by " >>> ".
 */
export function selectorFor(el: Element): string {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    return `${selectorFor(root.host)}${SHADOW_SEPARATOR}${selectorWithin(el, root)}`;
  }
  return selectorWithin(el, document);
}

const selectors = new WeakMap<Element, string>();

/** selectorFor, computed once per element: stable across widths and cheap to repeat. */
export function cachedSelector(el: Element): string {
  let s = selectors.get(el);
  if (s === undefined) {
    s = selectorFor(el);
    selectors.set(el, s);
  }
  return s;
}

/** Selectors of an element's ancestors below <body>, nearest first. */
export function lineage(el: Element, max = 16): string[] {
  const out: string[] = [];
  for (
    let p = composedParent(el);
    p && p !== document.body && out.length < max;
    p = composedParent(p)
  ) {
    out.push(cachedSelector(p));
  }
  return out;
}

/** Resolves a selector made by selectorFor, entering shadow roots at each " >>> ". */
export function resolveSelector(selector: string): Element | null {
  let root: Root | null = document;
  let found: Element | null = null;
  for (const part of selector.split(SHADOW_SEPARATOR)) {
    if (!root) return null;
    try {
      found = root.querySelector(part);
    } catch {
      return null;
    }
    root = found?.shadowRoot ?? null;
  }
  return found;
}

function readablePath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && parts.length < 4) {
    const cls = usefulClasses(current)[0];
    parts.unshift(current.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
    current = composedParent(current);
  }
  return parts.join(' > ');
}

/** The element's opening tag, with long attribute values shortened. */
function openingTag(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let out = `<${tag}`;
  for (const attr of el.attributes) {
    const value = attr.value.length > 60 ? `${attr.value.slice(0, 60)}...` : attr.value;
    out += value ? ` ${attr.name}="${value.replace(/"/g, '&quot;')}"` : ` ${attr.name}`;
  }
  out += '>';
  return out.length > 200 ? `${out.slice(0, 197)}...>` : out;
}

export function describe(el: Element): ElementInfo {
  const cached = cache.get(el);
  if (cached) return cached;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const info: ElementInfo = {
    selector: cachedSelector(el),
    path: readablePath(el),
    html: openingTag(el),
    text: text ? (text.length > 80 ? `${text.slice(0, 77)}...` : text) : null,
  };
  cache.set(el, info);
  owners.set(info, el);
  return info;
}
