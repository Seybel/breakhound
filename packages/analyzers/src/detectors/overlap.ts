import {
  type Box,
  type ElementRecord,
  intersectBox,
  isDeliberateOffset,
  isVisuallyHidden,
  px,
  type Snapshot,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';
import { pick } from './page-overflow';

const MIN_OVERLAP = 4;
/** Height of the page slices used to find candidate pairs quickly. */
const BAND_PX = 200;
/** Text must be covered by this share of one line's height, so tight line-height descenders don't count. */
const MIN_TEXT_LINE_SHARE = 0.3;

const REPLACED = new Set([
  'IMG',
  'VIDEO',
  'CANVAS',
  'IFRAME',
  'svg',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'BUTTON',
]);

interface Item {
  rec: ElementRecord;
  box: Box;
  /** What actually paints: the line pieces of text, or the box itself. */
  parts: Box[];
  /** Height of one text line, or 0 for media and controls. */
  lineHeight: number;
}

/** The painted, unclipped part of an item: the whole box for media/controls, the glyphs for text. */
function itemBox(rec: ElementRecord): Box | null {
  const raw = REPLACED.has(rec.el.tagName) ? rec.rect : rec.textRect;
  if (!raw || raw.width <= 0 || raw.height <= 0) return null;
  return intersectBox(raw, rec.clip);
}

function ancestors(rec: ElementRecord): ElementRecord[] {
  const chain: ElementRecord[] = [];
  let p: ElementRecord | null = rec;
  while (p) {
    chain.push(p);
    p = p.parent;
  }
  return chain;
}

function isExplicitlyPlacedGridItem(rec: ElementRecord): boolean {
  const s = rec.style;
  return s.gridRowStart !== 'auto' || s.gridColumnStart !== 'auto';
}

interface Branches {
  lca: ElementRecord | null;
  a: ElementRecord;
  b: ElementRecord;
}

/** Splits two records at their lowest common ancestor. Null if one contains the other. */
function branches(a: ElementRecord, b: ElementRecord): Branches | null {
  const chainA = ancestors(a).reverse();
  const chainB = ancestors(b).reverse();
  let i = 0;
  while (i < chainA.length && i < chainB.length && chainA[i] === chainB[i]) i++;
  const branchA = chainA[i];
  const branchB = chainB[i];
  if (!branchA || !branchB) return null;
  const lca = i > 0 ? (chainA[i - 1] ?? null) : null;
  // Anything between the item and the split point that overlaps deliberately excuses the pair.
  for (const rec of chainA.slice(i)) if (isDeliberateOffset(rec)) return null;
  for (const rec of chainB.slice(i)) if (isDeliberateOffset(rec)) return null;
  if (lca?.style.display.includes('grid')) {
    if (isExplicitlyPlacedGridItem(branchA) && isExplicitlyPlacedGridItem(branchB)) return null;
  }
  return { lca, a: branchA, b: branchB };
}

function intersect(a: Box, b: Box): { w: number; h: number } {
  return {
    w: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    h: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

/** The largest overlap between what two items actually paint, piece by piece. */
function paintedOverlap(x: Item, y: Item): { w: number; h: number } {
  let best = { w: 0, h: 0 };
  for (const a of x.parts) {
    for (const b of y.parts) {
      const o = intersect(a, b);
      if (o.w > 0 && o.h > 0 && o.w * o.h > best.w * best.h) best = o;
    }
  }
  return best;
}

interface Spill {
  /** The box whose content no longer fits in it. */
  box: ElementRecord;
  direction: 'down' | 'across';
}

interface Group {
  a: ElementRecord;
  b: ElementRecord;
  lca: ElementRecord | null;
  w: number;
  h: number;
  pairs: number;
  spill: Spill | null;
}

/** Room for borders and rounding before content counts as sticking out of its box. */
const SPILL_PX = 2;

/** Whether `branch` holds one of the two items, and that item sticks out of it. */
function spillOf(branch: ElementRecord, x: Item, y: Item): Spill | null {
  for (const item of [x, y]) {
    if (!ancestors(item.rec).includes(branch) || item.rec === branch) continue;
    const box = branch.rect;
    if (item.box.bottom > box.bottom + SPILL_PX) return { box: branch, direction: 'down' };
    if (item.box.right > box.right + SPILL_PX || item.box.left < box.left - SPILL_PX) {
      return { box: branch, direction: 'across' };
    }
  }
  return null;
}

function name(rec: ElementRecord): string {
  return `\`${describe(rec.el).selector}\``;
}

/** The likely fix, from how the two are laid out next to each other. */
/** The grid's items stay inside it, so its columns already shrink with it. */
function itemsFit(grid: ElementRecord): boolean {
  const { left, right } = grid.rect;
  return Array.from(grid.el.children).every((child) => {
    const r = child.getBoundingClientRect();
    return r.width === 0 || (r.left >= left - 1 && r.right <= right + 1);
  });
}

function suggestionFor(g: Group): string {
  if (g.spill?.direction === 'down') {
    return `The content of ${name(g.spill.box)} is taller than its box at this width and runs down over what comes next. Its height is fixed (height or max-height) and the content no longer fits once it wraps; use min-height instead, or let it grow with its content.`;
  }
  if (g.spill?.direction === 'across') {
    return `The content of ${name(g.spill.box)} is wider than its box at this width and runs sideways into its neighbour. Let it shrink or wrap (min-width: 0 on flex or grid items, overflow-wrap: anywhere for long words, max-width: 100% for media).`;
  }
  const lca = g.lca;
  const display = lca?.style.display ?? '';
  if (lca && display.includes('flex') && !lca.style.flexDirection.startsWith('column')) {
    return `They sit side by side in the flex row ${name(lca)}, which runs out of room at this width. Let the row wrap (flex-wrap: wrap), let the item that should give way shrink (min-width: 0), or stack them below this width with a media query.`;
  }
  if (lca && display.includes('grid')) {
    // Its items sticking out of it: the columns won't shrink below their content.
    if (!itemsFit(lca)) {
      return `They share the grid ${name(lca)}, whose columns are too narrow here for what is in them. Use minmax(0, 1fr) columns so items can shrink, or switch to fewer columns below this width.`;
    }
    return `They share the grid ${name(lca)}, whose columns have already shrunk as far as they go and are too narrow here for what is in them. Switch to fewer columns below this width.`;
  }
  return 'These two areas stop making room for each other at this width. Stack them earlier with a media query, or let the narrower one shrink (min-width: 0).';
}

/**
 * In-flow content (text, media, controls) painted on top of other in-flow
 * content. Pairs are grouped by the two sibling branches where their DOM paths
 * split, so one sidebar sliding over the main column is one finding.
 */
export function overlap(snap: Snapshot): Finding[] {
  const items: Item[] = [];
  for (const rec of snap.records) {
    if (rec.outOfFlow || isVisuallyHidden(rec)) continue;
    const box = itemBox(rec);
    if (!box || box.width < 1 || box.height < 1) continue;
    const isText = !REPLACED.has(rec.el.tagName);
    const parts = isText
      ? rec.textFragments
          .map((f) => intersectBox(f, rec.clip))
          .filter((f): f is Box => !!f && f.width > 0 && f.height > 0)
      : [];
    items.push({
      rec,
      box,
      parts: parts.length ? parts : [box],
      lineHeight: isText ? box.height / Math.max(1, rec.textLines) : 0,
    });
  }
  const groups = new Map<string, Group>();
  const index = new Map<ElementRecord, number>();
  for (const [i, r] of snap.records.entries()) index.set(r, i);

  // Only items sharing a horizontal band of the page can overlap. Each pair is
  // examined in the band where the lower of the two tops falls, so exactly once.
  const bands = new Map<number, Item[]>();
  for (const item of items) {
    const last = Math.floor(item.box.bottom / BAND_PX);
    for (let b = Math.floor(item.box.top / BAND_PX); b <= last; b++) {
      const list = bands.get(b);
      if (list) list.push(item);
      else bands.set(b, [item]);
    }
  }

  for (const [band, list] of bands) {
    list.sort((x, y) => x.box.left - y.box.left);
    for (let i = 0; i < list.length; i++) {
      const x = list[i] as Item;
      for (let j = i + 1; j < list.length; j++) {
        const y = list[j] as Item;
        if (y.box.left >= x.box.right - MIN_OVERLAP) break;
        if (Math.floor(Math.max(x.box.top, y.box.top) / BAND_PX) !== band) continue;
        // The union boxes overlapping is only a hint: text wrapping beside other text has
        // boxes that cross while every line piece sits clear of the rest.
        const rough = intersect(x.box, y.box);
        if (rough.w < MIN_OVERLAP || rough.h < MIN_OVERLAP) continue;
        const { w, h } = paintedOverlap(x, y);
        const minH = Math.max(
          MIN_OVERLAP,
          MIN_TEXT_LINE_SHARE * Math.max(x.lineHeight, y.lineHeight),
        );
        if (w < MIN_OVERLAP || h < minH) continue;
        const split = branches(x.rec, y.rec);
        if (!split) continue;
        const [first, second] =
          (index.get(split.a) ?? 0) < (index.get(split.b) ?? 0)
            ? [split.a, split.b]
            : [split.b, split.a];
        const key = `${index.get(first)}:${index.get(second)}`;
        const spill = spillOf(first, x, y) ?? spillOf(second, x, y);
        const g = groups.get(key);
        if (g) {
          g.w = Math.max(g.w, w);
          g.h = Math.max(g.h, h);
          g.pairs++;
          g.spill ??= spill;
        } else {
          groups.set(key, { a: first, b: second, lca: split.lca, w, h, pairs: 1, spill });
        }
      }
    }
  }

  const findings: Finding[] = [];
  for (const g of groups.values()) {
    findings.push({
      detector: 'overlap',
      severity: 'error',
      title: `Overlaps another element (${px(g.w)}×${px(g.h)}px)`,
      element: describe(g.a.el),
      related: describe(g.b.el),
      evidence: { overlapWidth: px(g.w), overlapHeight: px(g.h), overlappingPairs: g.pairs },
      suggestion: suggestionFor(g),
      styles: pick(g.a.style, [
        'display',
        'position',
        'width',
        'min-width',
        'flex-shrink',
        'grid-template-columns',
      ]),
    });
  }
  return findings;
}
