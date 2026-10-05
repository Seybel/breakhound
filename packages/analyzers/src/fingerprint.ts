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

/** One width threshold of an @container rule. */
interface ContainerQuery {
  /** Only containers with this container-name; null for the nearest container of any name. */
  name: string | null;
  value: number;
  unit: string;
  /** True when the rule flips once the container is wider than the value, not at it. */
  after: boolean;
}

const QUERY_UNITS = '(px|em|rem)';

/** Width thresholds in a container condition: "card (min-width: 400px)", "(width > 30em)". */
export function parseContainerCondition(text: string): ContainerQuery[] {
  const out: ContainerQuery[] = [];
  const name =
    text.match(/^\s*(?!not\b|style\b|scroll-state\b)([a-zA-Z_][\w-]*)\s*(?=\(|$)/)?.[1] ?? null;
  const add = (value: string, unit: string, after: boolean) =>
    out.push({ name, value: Number.parseFloat(value), unit, after });
  const legacy = new RegExp(`(min|max)-(?:width|inline-size)\\s*:\\s*([\\d.]+)${QUERY_UNITS}`, 'g');
  for (let m = legacy.exec(text); m; m = legacy.exec(text)) {
    add(m[2] ?? '0', m[3] ?? 'px', m[1] === 'max');
  }
  const range = new RegExp(`(?:width|inline-size)\\s*(>=|>|<=|<)\\s*([\\d.]+)${QUERY_UNITS}`, 'g');
  for (let m = range.exec(text); m; m = range.exec(text)) {
    add(m[2] ?? '0', m[3] ?? 'px', m[1] === '<=' || m[1] === '>');
  }
  const reversed = new RegExp(
    `([\\d.]+)${QUERY_UNITS}\\s*(>=|>|<=|<)\\s*(?:width|inline-size)`,
    'g',
  );
  for (let m = reversed.exec(text); m; m = reversed.exec(text)) {
    add(m[1] ?? '0', m[2] ?? 'px', m[3] === '<' || m[3] === '>=');
  }
  return out;
}

let queryCache: { key: string; queries: ContainerQuery[] } | null = null;

/** Every width threshold of every @container rule on the page, read again only when stylesheets change. */
function containerQueries(): ContainerQuery[] {
  if (typeof CSSContainerRule === 'undefined') return [];
  const roots: (Document | ShadowRoot)[] = [document, ...shadowRoots()];
  const sheets = roots.flatMap((r) => [...r.styleSheets, ...(r.adoptedStyleSheets ?? [])]);
  const key = sheets
    .map((s) => {
      try {
        return s.cssRules.length;
      } catch {
        return -1;
      }
    })
    .join(',');
  if (queryCache?.key === key) return queryCache.queries;

  const queries: ContainerQuery[] = [];
  const seen = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSContainerRule) {
        for (const q of parseContainerCondition(rule.conditionText)) {
          const id = `${q.name}|${q.value}${q.unit}|${q.after}`;
          if (!seen.has(id)) {
            seen.add(id);
            queries.push(q);
          }
        }
      }
      if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules);
        } catch {
          // Cross-origin.
        }
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of sheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Cross-origin stylesheet; its rules are not readable.
    }
  }
  queryCache = { key, queries };
  return queries;
}

const MAX_CONTAINER_BITS = 256;

/**
 * Which container query thresholds each size container is past, as a string of
 * bits. Where it changes between two viewport widths, a container query
 * switched: a layout change there is declared by the CSS, just not by a media query.
 */
export function containerSignature(snap: Snapshot): string | undefined {
  const queries = containerQueries();
  if (!queries.length) return undefined;
  const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let bits = '';
  for (const rec of snap.records) {
    const s = rec.style;
    if (!s.containerType || s.containerType === 'normal') continue;
    const names = s.containerName.split(/\s+/);
    const size =
      rec.rect.width -
      (Number.parseFloat(s.paddingLeft) || 0) -
      (Number.parseFloat(s.paddingRight) || 0) -
      (Number.parseFloat(s.borderLeftWidth) || 0) -
      (Number.parseFloat(s.borderRightWidth) || 0);
    for (const q of queries) {
      if (q.name && !names.includes(q.name)) continue;
      const unit =
        q.unit === 'px' ? 1 : q.unit === 'em' ? Number.parseFloat(s.fontSize) || 16 : rootFont;
      const threshold = q.value * unit;
      bits += (q.after ? size > threshold : size >= threshold) ? '1' : '0';
      if (bits.length >= MAX_CONTAINER_BITS) return bits;
    }
  }
  return bits || undefined;
}

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
