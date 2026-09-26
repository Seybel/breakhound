import type { ElementRecord, Snapshot } from './dom';

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

/** Widths at which the CSS declares a change, from min-width/max-width media and container queries. */
export function declaredBreakpoints(): number[] {
  const found = new Set<number>();
  const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

  const toPx = (value: string, unit: string) =>
    unit === 'px'
      ? Number.parseFloat(value)
      : Number.parseFloat(value) * (unit === 'rem' ? rootFont : 16);

  const read = (text: string) => {
    const re = /(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const [, kind, value = '0', unit = 'px'] = m;
      const w = toPx(value, unit);
      // max-width: 767px means the layout changes at 768.
      found.add(Math.round(kind === 'max' ? Math.floor(w) + 1 : w));
    }
    const range = /width\s*(>=|>|<=|<)\s*([\d.]+)(px|em|rem)/g;
    for (let m = range.exec(text); m; m = range.exec(text)) {
      const [, op, value = '0', unit = 'px'] = m;
      const w = toPx(value, unit);
      found.add(Math.round(op === '<=' || op === '>' ? Math.floor(w) + 1 : w));
    }
  };

  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) read(rule.conditionText ?? rule.media.mediaText);
      else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
        // Container queries depend on container size, not viewport; not viewport breakpoints.
        continue;
      }
      if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules)
        walk((rule as CSSGroupingRule).cssRules);
    }
  };

  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Cross-origin stylesheet; its rules are not readable.
    }
  }
  return [...found].filter((w) => w > 0).sort((a, b) => a - b);
}
