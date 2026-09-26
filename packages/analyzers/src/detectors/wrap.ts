import { type ElementRecord, isVisuallyHidden, type Snapshot } from '../dom';
import { describe } from '../selector';
import type { WrapStat } from '../types';

/** Where a row wrapping onto a second line is almost always a bug. Filter toolbars wrap by design. */
const NAV_CONTEXT =
  'nav, header, [role="navigation"], [role="tablist"], [role="menubar"], [role="banner"]';
const LABEL = 'button, [role="button"], [role="tab"], [role="menuitem"]';
const MAX_LABEL_CHARS = 40;

function isRowContainer(rec: ElementRecord): boolean {
  const s = rec.style;
  if (s.display === 'flex' || s.display === 'inline-flex') {
    return s.flexDirection.startsWith('row') && s.flexWrap !== 'nowrap';
  }
  return false;
}

function inlineChildren(
  rec: ElementRecord,
  byElement: Map<Element, ElementRecord>,
): ElementRecord[] {
  const out: ElementRecord[] = [];
  for (const child of rec.el.children) {
    const c = byElement.get(child);
    if (!c || c.outOfFlow || isVisuallyHidden(c)) continue;
    out.push(c);
  }
  return out;
}

function allInlineLevel(children: ElementRecord[]): boolean {
  return (
    children.length > 0 &&
    children.every(
      (c) => c.style.display.startsWith('inline') && c.style.display !== 'inline-table',
    )
  );
}

function countRows(children: ElementRecord[]): number {
  const tops: number[] = [];
  for (const c of children) {
    const half = Math.max(4, c.rect.height / 2);
    if (!tops.some((t) => Math.abs(t - c.rect.top) < half)) tops.push(c.rect.top);
  }
  return tops.length;
}

function textLinesDeep(el: Element): number {
  const tops: { top: number; height: number }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width === 0 || r.height === 0) continue;
      if (!tops.some((t) => Math.abs(t.top - r.top) < Math.max(t.height, r.height) / 2)) {
        tops.push({ top: r.top, height: r.height });
      }
    }
  }
  return tops.length;
}

/**
 * Line counts for rows of nav links/buttons and for button labels. Whether a
 * count is "unexpected" is decided across widths by the engine.
 */
export function wrapStats(snap: Snapshot): WrapStat[] {
  const stats: WrapStat[] = [];
  for (const rec of snap.records) {
    if (isVisuallyHidden(rec)) continue;

    const children = inlineChildren(rec, snap.byElement);
    if (children.length >= 2 && (isRowContainer(rec) || allInlineLevel(children))) {
      // Chip lists and button groups wrap by design; navigation rows almost never should.
      if (rec.el.closest(NAV_CONTEXT)) {
        stats.push({
          element: describe(rec.el),
          kind: 'row',
          lines: countRows(children),
          items: children.length,
        });
      }
    }

    const isLabel =
      rec.el.matches(LABEL) || (rec.el.matches('a[href]') && rec.el.closest(NAV_CONTEXT) !== null);
    if (isLabel) {
      const text = rec.el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (text && text.length <= MAX_LABEL_CHARS && text.includes(' ')) {
        stats.push({
          element: describe(rec.el),
          kind: 'label',
          lines: textLinesDeep(rec.el),
          items: 1,
        });
      }
    }
  }
  return stats;
}
