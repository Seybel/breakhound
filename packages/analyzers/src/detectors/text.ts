import {
  breaksAnywhere,
  contentBox,
  type ElementRecord,
  fontSize,
  intersectBox,
  isInline,
  isOrnament,
  isVisuallyHidden,
  px,
  type Snapshot,
  TOUCH_MAX_WIDTH,
} from '../dom';
import { describe } from '../selector';
import type { Finding } from '../types';
import { pick } from './page-overflow';

const CUT_TOLERANCE = 1;
/** Text closer than this to the screen edge on a phone looks broken. */
const MIN_GUTTER = 4;
const MIN_TINY_FONT = 12;
const MAX_TINY_FINDINGS = 8;
/** Display text from this size up is checked for being too big for a phone. */
const MIN_LARGE_FONT = 28;
/** Fewer characters a line than this is a word or two: the text is too big for the screen. */
const MIN_LARGE_CHARS_PER_LINE = 12;
const MAX_LARGE_FINDINGS = 8;

function scrollsOn(style: CSSStyleDeclaration, axis: 'x' | 'y'): boolean {
  const v = axis === 'x' ? style.overflowX : style.overflowY;
  return v === 'auto' || v === 'scroll';
}

function clipsOn(style: CSSStyleDeclaration, axis: 'x' | 'y'): boolean {
  return (axis === 'x' ? style.overflowX : style.overflowY) !== 'visible';
}

function truncatesOnPurpose(rec: ElementRecord, axis: 'x' | 'y'): boolean {
  const s = rec.style as CSSStyleDeclaration & { webkitLineClamp?: string };
  if (axis === 'x') return s.textOverflow === 'ellipsis' || s.textOverflow === 'clip';
  return !!s.webkitLineClamp && s.webkitLineClamp !== 'none';
}

/** The nearest element (self included) that cuts the text on the given axis. */
function findClipper(
  rec: ElementRecord,
  raw: { left: number; right: number; top: number; bottom: number },
  axis: 'x' | 'y',
) {
  for (let p: ElementRecord | null = rec; p; p = p.parent) {
    if (!clipsOn(p.style, axis)) continue;
    const cut =
      axis === 'x'
        ? raw.left < p.rect.left - CUT_TOLERANCE || raw.right > p.rect.right + CUT_TOLERANCE
        : raw.top < p.rect.top - CUT_TOLERANCE || raw.bottom > p.rect.bottom + CUT_TOLERANCE;
    if (cut) return p;
  }
  return null;
}

/** Clipping containers that show at least some of their text. */
function clippersWithVisibleText(snap: Snapshot): Set<ElementRecord> {
  const out = new Set<ElementRecord>();
  for (const rec of snap.records) {
    if (!rec.textRect) continue;
    for (let p = rec.parent; p; p = p.parent) {
      if (out.has(p)) break;
      if (clipsOn(p.style, 'y')) out.add(p);
    }
  }
  return out;
}

/**
 * Text hidden by a container with overflow hidden and a fixed size, whether a
 * line is cut in half or whole paragraphs are pushed below the bottom edge.
 * Deliberate truncation (ellipsis, line-clamp), scrollable containers, sliders,
 * collapsed panels and full-width wrappers (reported as page overflow) are
 * skipped. The engine additionally drops clips that already exist at the widest
 * width, since those are part of the design rather than a responsive bug.
 */
export function clippedText(snap: Snapshot): Finding[] {
  const byClipper = new Map<
    ElementRecord,
    { rec: ElementRecord; axis: 'x' | 'y'; cut: number; count: number }
  >();
  const vw = snap.viewportWidth;
  let showing: Set<ElementRecord> | null = null;

  for (const rec of snap.records) {
    const raw = rec.rawTextRect;
    if (!raw || rec.outOfFlow === 'fixed' || isVisuallyHidden(rec) || isOrnament(rec)) continue;
    const visible = intersectBox(raw, rec.innerClip);
    let axis: 'x' | 'y' | null;
    let clipper: ElementRecord | null;
    let cut: number;
    if (visible) {
      const cutX = raw.width - visible.width;
      const cutY = raw.height - visible.height;
      axis = cutY > CUT_TOLERANCE ? 'y' : cutX > CUT_TOLERANCE ? 'x' : null;
      if (!axis) continue;
      clipper = findClipper(rec, raw, axis);
      cut = axis === 'x' ? cutX : cutY;
    } else {
      // Entirely hidden. Only a problem when it was pushed out below content
      // that is still showing; otherwise it's a collapsed panel or a hidden slide.
      axis = 'y';
      clipper = findClipper(rec, raw, 'y');
      if (!clipper || raw.top < clipper.rect.bottom - CUT_TOLERANCE) continue;
      showing ??= clippersWithVisibleText(snap);
      if (!showing.has(clipper)) continue;
      cut = raw.bottom - clipper.rect.bottom;
    }
    if (!clipper || scrollsOn(clipper.style, axis) || clipper.rect.height < 2) continue;
    if (axis === 'x' && clipper.rect.left <= 1 && clipper.rect.right >= vw - 1) continue;

    let deliberate = false;
    for (let p: ElementRecord | null = rec; p; p = p.parent) {
      if (truncatesOnPurpose(p, axis) || (p.style.transform && p.style.transform !== 'none')) {
        deliberate = true;
        break;
      }
      if (p === clipper) break;
    }
    if (deliberate) continue;

    const prev = byClipper.get(clipper);
    if (prev) {
      prev.count++;
      if (cut > prev.cut) Object.assign(prev, { rec, axis, cut });
    } else {
      byClipper.set(clipper, { rec, axis, cut, count: 1 });
    }
  }

  const findings: Finding[] = [];
  for (const [clipper, { rec, axis, cut, count }] of byClipper) {
    const fixedSize = axis === 'y' ? clipper.style.height : clipper.style.width;
    findings.push({
      detector: 'clipped-text',
      severity: 'warning',
      title: `Container cuts off its text (${px(cut)}px hidden ${axis === 'y' ? 'below' : 'to the side'})`,
      element: describe(clipper.el),
      related: describe(rec.el),
      evidence: { hiddenPx: px(cut), axis, clippedTextElements: count },
      styles: pick(clipper.style, [
        'height',
        'max-height',
        'width',
        'max-width',
        'overflow',
        'white-space',
      ]),
      suggestion:
        axis === 'y'
          ? `The container clips its content at ${fixedSize}. Let it grow (min-height instead of height), or truncate on purpose with line-clamp.`
          : 'The container is too narrow for this text. Let the text wrap, or truncate on purpose with text-overflow: ellipsis.',
    });
  }
  return findings;
}

/** Text crushed into a column so narrow that words break mid-word. */
export function squishedText(snap: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const rec of snap.records) {
    if (!rec.textRect || rec.textLines < 3 || isVisuallyHidden(rec) || isInline(rec.style))
      continue;
    const chars = rec.text.replace(/\s/g, '').length;
    if (chars < 8) continue;
    // Only genuinely narrow columns; a full-width URL breaking anywhere is doing its job.
    if (rec.rect.width >= 10 * fontSize(rec)) continue;
    const words = rec.text.split(' ').filter(Boolean).length;
    const perLine = chars / rec.textLines;
    // One word per line is ordinary wrapping; more lines than words means words are breaking apart.
    // Chinese, Japanese, Korean and Thai wrap between any characters, so only a tiny column counts.
    if ((rec.textLines <= words || breaksAnywhere(rec.text)) && perLine >= 3) continue;
    findings.push({
      detector: 'squished-text',
      severity: 'warning',
      title: `Text squeezed to about ${Math.max(1, Math.round(perLine))} characters per line`,
      element: describe(rec.el),
      evidence: {
        lines: rec.textLines,
        charsPerLine: Math.round(perLine * 10) / 10,
        width: px(rec.rect.width),
      },
      styles: pick(rec.style, ['width', 'min-width', 'flex-basis', 'word-break', 'overflow-wrap']),
      suggestion:
        'This column gets too narrow at this width. Give it a min-width, or stack the layout earlier.',
    });
  }
  return findings;
}

/** A form control still in the browser's own font: smaller than the text around it. */
function browserDefault(rec: ElementRecord): boolean {
  const control = rec.el.closest('button, input, select, textarea');
  if (!control) return false;
  const around = control.parentElement;
  return !!around && fontSize(rec) < Number.parseFloat(getComputedStyle(around).fontSize);
}

/** Text below 12px on phone-sized screens, one finding per parent (a row of captions is one fix). */
export function tinyText(snap: Snapshot): Finding[] {
  if (snap.viewportWidth > TOUCH_MAX_WIDTH) return [];
  const byParent = new Map<
    ElementRecord | null,
    { rec: ElementRecord; size: number; count: number }
  >();
  for (const rec of snap.records) {
    if (!rec.textRect || rec.text.length < 3 || isVisuallyHidden(rec) || isOrnament(rec)) continue;
    const size = fontSize(rec);
    if (size >= MIN_TINY_FONT) continue;
    const g = byParent.get(rec.parent);
    if (g) {
      g.count++;
      if (size < g.size) Object.assign(g, { rec, size });
    } else {
      byParent.set(rec.parent, { rec, size, count: 1 });
    }
  }

  const findings: Finding[] = [];
  for (const [parent, g] of byParent) {
    if (findings.length >= MAX_TINY_FINDINGS) break;
    const grouped = g.count > 1 && parent !== null;
    const size = Math.round(g.size * 10) / 10;
    findings.push({
      detector: 'tiny-text',
      severity: 'info',
      title:
        g.count > 1
          ? `${g.count} pieces of text are ${size}px on small screens`
          : `Text is ${size}px on small screens`,
      element: describe(grouped ? parent.el : g.rec.el),
      ...(grouped ? { related: describe(g.rec.el) } : {}),
      evidence: { fontSizePx: size, textElements: g.count },
      styles: pick(g.rec.style, ['font-size', 'line-height']),
      suggestion: browserDefault(g.rec)
        ? "Form controls don't take the page's font unless told to, and Safari's default is 11px. Add font: inherit to button, input, select and textarea."
        : 'Use at least 12px (16px for body text) on small screens.',
    });
  }
  return findings;
}

/** Lines the author asked for: one per <br>, or per newline where white-space keeps them. */
function forcedLines(el: Element, style: CSSStyleDeclaration): number {
  let lines = 1;
  const keepsNewlines = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(style.whiteSpace);
  for (const node of el.childNodes) {
    if (node.nodeName === 'BR') lines++;
    else if (keepsNewlines && node.nodeType === Node.TEXT_NODE) {
      lines += (node.textContent?.trim().match(/\n/g) ?? []).length;
    }
  }
  return lines;
}

/**
 * Headings and other display text kept at their desktop size on a phone, so they wrap a word or
 * two at a time and fill the screen. It has to be the size and the screen at fault, so it stays
 * quiet whenever the stacking could be on purpose: line breaks written into the text, a heading
 * kept narrower than the space it has, text in a narrow column (the column is the problem there),
 * decorative text hidden from screen readers or laid over the page, and vertical text.
 */
export function oversizedText(snap: Snapshot): Finding[] {
  const vw = snap.viewportWidth;
  if (vw > TOUCH_MAX_WIDTH) return [];
  const findings: Finding[] = [];
  for (const rec of snap.records) {
    if (findings.length >= MAX_LARGE_FINDINGS) break;
    if (!rec.textRect || rec.textLines < 3 || isVisuallyHidden(rec)) continue;
    const size = fontSize(rec);
    if (size < MIN_LARGE_FONT) continue;
    // One long word is overflow or squished text; CJK and Thai have no spaces to count words by.
    const words = rec.text.split(' ').filter(Boolean).length;
    if (words < 2) continue;
    const chars = rec.text.replace(/\s/g, '').length;
    const perLine = chars / rec.textLines;
    if (perLine >= MIN_LARGE_CHARS_PER_LINE) continue;
    // Words breaking apart in a narrow column is squished-text's to report.
    if (rec.textLines > words && rec.rect.width < 10 * size) continue;
    if (rec.style.writingMode && !rec.style.writingMode.startsWith('horizontal')) continue;
    if (rec.outOfFlow || isOrnament(rec)) continue;
    // Size has to add at least two lines to the ones the author wrote in.
    if (rec.textLines - forcedLines(rec.el, rec.style) < 2) continue;
    // The text's block has to fill the space it's given, and that space most of the screen.
    let block: ElementRecord = rec;
    while (!isBlock(block) && block.parent) block = block.parent;
    const room = block.parent ? contentBox(block.parent).width : vw;
    if (block.rect.width < room * 0.9 || block.rect.width < vw * 0.6) continue;

    const rem = Math.round((size / 16) * 100) / 100;
    findings.push({
      detector: 'oversized-text',
      severity: 'warning',
      title: `Text is too big for the screen (${px(size)}px, ${rec.textLines} lines of a word or two)`,
      element: describe(rec.el),
      evidence: {
        fontSizePx: px(size),
        lines: rec.textLines,
        charsPerLine: Math.round(perLine * 10) / 10,
        screenShare: Math.round((rec.textRect.height / snap.viewportHeight) * 100) / 100,
      },
      styles: pick(rec.style, ['font-size', 'line-height', 'letter-spacing']),
      suggestion: `Scale it down on small screens, for example font-size: clamp(1.75rem, 4vw + 1rem, ${rem}rem), or a smaller size below 640px.`,
    });
  }
  return findings;
}

function isBlock(rec: ElementRecord): boolean {
  return !rec.style.display.startsWith('inline') && rec.style.display !== 'contents';
}

/**
 * Text pressed against the left or right edge of a phone screen. Blamed on the
 * container that should have horizontal padding, one finding per container.
 */
export function edgeGutter(snap: Snapshot): Finding[] {
  const vw = snap.viewportWidth;
  if (vw > TOUCH_MAX_WIDTH) return [];
  const groups = new Map<
    ElementRecord,
    { side: 'left' | 'right'; gap: number; count: number; rec: ElementRecord }
  >();

  for (const rec of snap.records) {
    const t = rec.textRect;
    if (!t || rec.outOfFlow === 'fixed' || isVisuallyHidden(rec) || rec.text.length < 2) continue;
    if (isOrnament(rec)) continue;
    // Overflowing text is page-overflow's job; text in scrollers and sliders is meant to move.
    if (t.left < -0.5 || t.right > vw + 0.5) continue;
    let moves = false;
    for (let p = rec.parent; p; p = p.parent) {
      if (scrollsOn(p.style, 'x') || (p.style.transform && p.style.transform !== 'none')) {
        moves = true;
        break;
      }
    }
    if (moves) continue;

    // Judge the padding of the block the text sits in, not where each line happens to end.
    let container: ElementRecord = rec;
    while (!isBlock(container) && container.parent) container = container.parent;
    const box = contentBox(container);
    const leftGap = box.left;
    const rightGap = vw - box.right;
    let side: 'left' | 'right' | null = null;
    if (leftGap < MIN_GUTTER && t.left < MIN_GUTTER + 0.5) side = 'left';
    else if (rightGap < MIN_GUTTER && (rec.textLines >= 2 || t.right > vw - MIN_GUTTER))
      side = 'right';
    if (!side) continue;
    const gap = side === 'left' ? leftGap : rightGap;
    const g = groups.get(container);
    if (g) {
      g.count++;
      if (gap < g.gap) Object.assign(g, { gap, side, rec });
    } else {
      groups.set(container, { side, gap, count: 1, rec });
    }
  }

  const findings: Finding[] = [];
  for (const [container, g] of groups) {
    findings.push({
      detector: 'edge-gutter',
      severity: 'warning',
      title: `Text touches the ${g.side} edge of the screen (${Math.max(0, px(g.gap))}px gap)`,
      element: describe(container.el),
      evidence: { gapPx: Math.max(0, px(g.gap)), side: g.side, textElements: g.count },
      styles: pick(container.style, [
        'padding-left',
        'padding-right',
        'margin-left',
        'margin-right',
        'width',
      ]),
      suggestion: 'Add horizontal padding (around 16px) to this container on small screens.',
    });
  }
  return findings;
}
