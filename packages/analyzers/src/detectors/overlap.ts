import {
  type Box,
  type ElementRecord,
  intersectBox,
  isVisuallyHidden,
  px,
  type Snapshot,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';
import { pick } from './page-overflow';

const MIN_OVERLAP = 4;
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

/** A layout technique that overlaps on purpose. */
function isDeliberate(rec: ElementRecord): boolean {
  const s = rec.style;
  if ((Number.parseFloat(s.marginLeft) || 0) < 0) return true;
  if ((Number.parseFloat(s.marginRight) || 0) < 0) return true;
  if ((Number.parseFloat(s.marginTop) || 0) < 0) return true;
  if ((Number.parseFloat(s.marginBottom) || 0) < 0) return true;
  if (s.transform && s.transform !== 'none') return true;
  if (
    s.position === 'relative' &&
    ((s.top !== 'auto' && s.top !== '0px') || (s.left !== 'auto' && s.left !== '0px'))
  ) {
    return true;
  }
  return false;
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
  for (const rec of chainA.slice(i)) if (isDeliberate(rec)) return null;
  for (const rec of chainB.slice(i)) if (isDeliberate(rec)) return null;
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
    items.push({ rec, box, lineHeight: isText ? box.height / Math.max(1, rec.textLines) : 0 });
  }
  items.sort((x, y) => x.box.left - y.box.left);

  const groups = new Map<
    string,
    { a: ElementRecord; b: ElementRecord; w: number; h: number; pairs: number }
  >();
  const index = new Map<ElementRecord, number>();
  for (const [i, r] of snap.records.entries()) index.set(r, i);

  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x) continue;
    for (let j = i + 1; j < items.length; j++) {
      const y = items[j];
      if (!y) continue;
      if (y.box.left >= x.box.right - MIN_OVERLAP) break;
      const { w, h } = intersect(x.box, y.box);
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
      const g = groups.get(key);
      if (g) {
        g.w = Math.max(g.w, w);
        g.h = Math.max(g.h, h);
        g.pairs++;
      } else {
        groups.set(key, { a: first, b: second, w, h, pairs: 1 });
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
      suggestion:
        'These two areas stop making room for each other at this width. Stack them earlier with a media query, or let the narrower one shrink (min-width: 0).',
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
