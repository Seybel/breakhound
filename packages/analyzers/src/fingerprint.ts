import { type ElementRecord, type Snapshot, shadowRoots } from './dom';

const LANDMARKS = new Set([
  'HEADER',
  'NAV',
  'MAIN',
  'ASIDE',
  'FOOTER',
  'SECTION',
  'ARTICLE',
  'FORM',
]);
const MAX_DEPTH = 5;
const MAX_ELEMENTS = 400;

function isStructural(rec: ElementRecord, depth: number): boolean {
  if (depth <= 3) return true;
  if (LANDMARKS.has(rec.el.tagName)) return true;
  const d = rec.style.display;
  return depth <= MAX_DEPTH && (d.includes('flex') || d.includes('grid'));
}

function rowsAndColumns(children: ElementRecord[]): string {
  // Group siblings into rows by top edge, then record how many sit in each row.
  const rows: number[] = [];
  const counts: number[] = [];
  for (const c of children) {
    const tol = Math.max(4, Math.min(c.rect.height / 2, 24));
    const i = rows.findIndex((t) => Math.abs(t - c.rect.top) < tol);
    if (i === -1) {
      rows.push(c.rect.top);
      counts.push(1);
    } else {
      counts[i] = (counts[i] ?? 0) + 1;
    }
  }
  return counts.join('.');
}

/**
 * A discrete description of the layout: which structural elements are
 * rendered, their display mode, and how their children are arranged into rows.
 * Fluid resizing leaves it unchanged; it only changes at behavioural breakpoints.
 */
export function layoutSignature(snap: Snapshot, index: (el: Element) => string): string {
  const children = new Map<ElementRecord, ElementRecord[]>();
  for (const rec of snap.records) {
    if (!rec.parent || rec.outOfFlow === 'fixed') continue;
    const list = children.get(rec.parent);
    if (list) list.push(rec);
    else children.set(rec.parent, [rec]);
  }

  // Depth counted only where the tree branches, so single-child wrapper chains
  // (framework roots, providers, layout shells) don't push real layout out of view.
  const branchDepth = new Map<ElementRecord, number>();
  for (const rec of snap.records) {
    const parent = rec.parent;
    const parentDepth = parent ? (branchDepth.get(parent) ?? 0) : 0;
    const branches = parent ? (children.get(parent)?.length ?? 0) > 1 : true;
    branchDepth.set(rec, parentDepth + (branches ? 1 : 0));
  }

  const parts: string[] = [];
  for (const rec of snap.records) {
    if (parts.length >= MAX_ELEMENTS) break;
    // Fixed overlays (toasts, chat widgets, cookie bars) float over the layout rather than being part of it.
    if (rec.outOfFlow === 'fixed' || !isStructural(rec, branchDepth.get(rec) ?? 0)) continue;
    // Inline children reflow with the text at almost every width; only block-level arrangement counts.
    const kids = (children.get(rec) ?? []).filter(
      (c) => !c.outOfFlow && !c.style.display.startsWith('inline'),
    );
    const s = rec.style;
    let mode = s.display;
    if (mode.includes('flex')) mode += `/${s.flexDirection}`;
    // Wrapping flex rows reflow continuously with their content; that is not a layout breakpoint.
    const wraps = mode.includes('flex') && s.flexWrap !== 'nowrap';
    const arrangement = kids.length > 1 && !wraps ? rowsAndColumns(kids) : String(kids.length);
    parts.push(`${index(rec.el)}=${mode}:${arrangement}`);
  }
  return parts.join('|');
}

/** Media queries resolve em and rem against the browser default, not the page's root font size. */
const MEDIA_EM = 16;

/**
 * Widths at which the CSS declares a change, from min-width/max-width and
 * range syntax media queries, in documents, shadow roots and adopted sheets.
 */
export function declaredBreakpoints(): number[] {
  const found = new Set<number>();
  const toPx = (value: string, unit: string) =>
    Number.parseFloat(value) * (unit === 'px' ? 1 : MEDIA_EM);
  // A change "after" w (max-width: 767px, width > 767px) shows up at the next whole pixel.
  const after = (w: number) => Math.floor(w) + 1;

  const read = (text: string) => {
    const legacy = /(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/g;
    for (let m = legacy.exec(text); m; m = legacy.exec(text)) {
      const [, kind, value = '0', unit = 'px'] = m;
      const w = toPx(value, unit);
      found.add(Math.round(kind === 'max' ? after(w) : w));
    }
    // width >= 48rem, width < 768px
    const range = /width\s*(>=|>|<=|<)\s*([\d.]+)(px|em|rem)/g;
    for (let m = range.exec(text); m; m = range.exec(text)) {
      const [, op, value = '0', unit = 'px'] = m;
      const w = toPx(value, unit);
      found.add(Math.round(op === '<=' || op === '>' ? after(w) : w));
    }
    // 48rem <= width, 768px > width
    const reversed = /([\d.]+)(px|em|rem)\s*(>=|>|<=|<)\s*width/g;
    for (let m = reversed.exec(text); m; m = reversed.exec(text)) {
      const [, value = '0', unit = 'px', op] = m;
      const w = toPx(value, unit);
      found.add(Math.round(op === '<' || op === '>=' ? after(w) : w));
    }
  };

  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
        // Container queries depend on container size, not the viewport.
        continue;
      }
      if (rule instanceof CSSMediaRule) read(rule.conditionText ?? rule.media.mediaText);
      else if (rule instanceof CSSImportRule) {
        read(rule.media.mediaText);
        readSheet(rule.styleSheet);
        continue;
      }
      if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules)
        walk((rule as CSSGroupingRule).cssRules);
    }
  };

  const readSheet = (sheet: CSSStyleSheet | null) => {
    if (!sheet) return;
    // <link media="(min-width: 768px)">
    read(sheet.media.mediaText);
    try {
      walk(sheet.cssRules);
    } catch {
      // Cross-origin stylesheet; its rules are not readable.
    }
  };

  const roots: (Document | ShadowRoot)[] = [document, ...shadowRoots()];
  for (const root of roots) {
    for (const sheet of root.styleSheets) readSheet(sheet);
    for (const sheet of root.adoptedStyleSheets ?? []) readSheet(sheet);
  }
  return [...found].filter((w) => w > 0).sort((a, b) => a - b);
}
