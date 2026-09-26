import type { ElementInfo } from './types';

const cache = new WeakMap<Element, ElementInfo>();

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
  if (withNth && el.parentElement) {
    const same = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

function isUnique(selector: string, el: Element): boolean {
  try {
    const found = document.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

export function selectorFor(el: Element): string {
  if (el.id && isStableId(el.id) && isUnique(`#${cssEscape(el.id)}`, el))
    return `#${cssEscape(el.id)}`;

  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    if (current !== el && current.id && isStableId(current.id)) {
      parts.unshift(`#${cssEscape(current.id)}`);
      const candidate = parts.join(' > ');
      if (isUnique(candidate, el)) return candidate;
      parts.shift();
    }
    // Try the cheapest segment that makes the chain unique.
    for (const [cls, nth] of [
      [true, false],
      [true, true],
    ] as const) {
      const candidate = [segment(current, cls, nth), ...parts].join(' > ');
      if (isUnique(candidate, el)) return candidate;
    }
    parts.unshift(segment(current, true, true));
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function readablePath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body && parts.length < 4) {
    const cls = usefulClasses(current)[0];
    parts.unshift(current.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function openingTag(el: Element): string {
  const html = el.outerHTML;
  const end = html.indexOf('>');
  const tag = end === -1 ? html : html.slice(0, end + 1);
  return tag.length > 200 ? `${tag.slice(0, 197)}...>` : tag;
}

export function describe(el: Element): ElementInfo {
  const cached = cache.get(el);
  if (cached) return cached;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const info: ElementInfo = {
    selector: selectorFor(el),
    path: readablePath(el),
    html: openingTag(el),
    text: text ? (text.length > 80 ? `${text.slice(0, 77)}...` : text) : null,
  };
  cache.set(el, info);
  return info;
}
