import { composedParent, type ElementRecord, renderedChildren, type Snapshot } from '../dom';
import { describe, elementOf, lineage } from '../selector';
import type { DetectorId, Finding, Severity } from '../types';

/**
 * A month or week calendar has to show 7 days side by side, so when its days run out of room
 * the usual fixes (let it shrink, fewer columns, break the words) make it worse. What breaks
 * inside one is reported once, as the calendar, and the engine says how to fix a calendar.
 *
 * It's recognised strictly: a row of the 7 weekday names, in order, over day cells lined up
 * under them, tall enough or full enough to hold events. A date picker (a small grid of day
 * numbers) is left alone: it isn't something people would read as a list.
 */

/** What breaks when the days are too narrow. Tap targets and small text have their own fixes. */
const FOLDED = new Set<DetectorId>([
  'page-overflow',
  'content-overflow',
  'media-overflow',
  'overlap',
  'clipped-text',
  'squished-text',
]);

/** Day cells this tall have room for events; a date picker's are about 30 to 48px. */
const EVENT_CELL_HEIGHT = 56;
/** Lined up under a weekday: the same left edge and width, give or take. */
const ALIGN_PX = 2;
/**
 * How far above the weekdays the days can be. Calendar libraries often put the weekdays in a
 * table of their own, several wrappers away from the days' table.
 */
const MAX_LEVELS = 10;
/** Abbreviations that aren't the start of the full name. */
const ALIASES: Record<string, string> = { weds: 'wednesday' };

const normalize = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,:]$/, '');

interface WeekNames {
  long: string[];
  exact: Set<string>[];
}

let names: { key: string; weeks: WeekNames[] } | null = null;

/** The weekday names, Monday first, in the page's language and English. */
function weekNames(): WeekNames[] {
  const langs = [document.documentElement.lang, navigator.language, 'en'].filter(Boolean);
  const key = langs.join('|');
  if (names?.key === key) return names.weeks;
  const weeks: WeekNames[] = [];
  for (const lang of new Set(langs)) {
    try {
      const format = (weekday: 'long' | 'short' | 'narrow') =>
        new Intl.DateTimeFormat(lang, { weekday, timeZone: 'UTC' });
      // 2024-01-01 was a Monday.
      const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)));
      const long = days.map((d) => normalize(format('long').format(d)));
      const exact = days.map(
        (d, i) =>
          new Set([
            long[i] as string,
            normalize(format('short').format(d)),
            normalize(format('narrow').format(d)),
          ]),
      );
      weeks.push({ long, exact });
    } catch {
      // A language tag Intl doesn't know.
    }
  }
  names = { key, weeks };
  return weeks;
}

function isDay(text: string, week: WeekNames, day: number): boolean {
  if (week.exact[day]?.has(text) || ALIASES[text] === week.long[day]) return true;
  // "Mo", "Tue", "Thurs": the start of the full name.
  return text.length >= 2 && (week.long[day]?.startsWith(text) ?? false);
}

/** True when these are the 7 weekdays in order, starting on any day. */
function isWeek(texts: string[]): boolean {
  if (texts.length !== 7 || texts.some((t) => !t)) return false;
  return weekNames().some((week) =>
    Array.from({ length: 7 }, (_, start) => start).some((start) =>
      texts.every((t, i) => isDay(t, week, (start + i) % 7)),
    ),
  );
}

export interface Calendar {
  root: Element;
  /** The weekday cells, in order. */
  weekdays: ElementRecord[];
  days: ElementRecord[];
  /** It sits in a box that scrolls sideways, so it can't push the page wide. */
  scrolls: boolean;
}

const lined = (a: ElementRecord, b: ElementRecord) =>
  Math.abs(a.rect.left - b.rect.left) <= ALIGN_PX &&
  Math.abs(a.rect.width - b.rect.width) <= ALIGN_PX;

/** Cells under the weekdays, inside `scope`, that aren't the weekdays themselves. */
function dayCells(snap: Snapshot, scope: Element, weekdays: ElementRecord[]): ElementRecord[] {
  const header = new Set(weekdays.map((w) => w.el));
  const out: ElementRecord[] = [];
  for (const el of scope.querySelectorAll('*')) {
    if (header.has(el) || weekdays.some((w) => w.el.contains(el))) continue;
    const rec = snap.byElement.get(el);
    if (!rec || rec.rect.height < 1) continue;
    // The outermost cell in each column, not what's inside it.
    if (out.some((o) => o.el.contains(el))) continue;
    if (weekdays.some((w) => lined(w, rec)) && rec.rect.top >= (weekdays[0]?.rect.bottom ?? 0) - 1)
      out.push(rec);
  }
  return out;
}

/** Days with room for events, rather than a date picker's small squares of day numbers. */
function holdsEvents(days: ElementRecord[]): boolean {
  const heights = days.map((d) => d.rect.height).sort((a, b) => a - b);
  return (heights[Math.floor(heights.length / 2)] ?? 0) >= EVENT_CELL_HEIGHT;
}

/** What a heading shows: "Mon" from <span class="sm:hidden">M</span><span>Mon</span>. */
function shownText(el: Element): string {
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  // A week view's "Mon 12" is still Monday.
  return normalize((text ?? '').replace(/\d+/g, ' '));
}

/** 7 weekdays side by side among these cells, after a week number or time column if any. */
function weekRow(snap: Snapshot, cells: Element[]): ElementRecord[] | null {
  for (let start = 0; start <= 1 && start + 7 <= cells.length; start++) {
    const row = cells
      .slice(start, start + 7)
      .map((c) => snap.byElement.get(c))
      .filter((r): r is ElementRecord => !!r && r.rect.width > 0);
    if (row.length !== 7 || !isWeek(row.map((r) => shownText(r.el)))) continue;
    // Side by side, in one row.
    const tops = row.map((r) => Math.round(r.rect.top));
    if (Math.max(...tops) - Math.min(...tops) <= ALIGN_PX) return row;
  }
  return null;
}

function scrollsSideways(snap: Snapshot, el: Element): boolean {
  for (let p: Element | null = el; p && p !== document.body; p = composedParent(p)) {
    const overflow = snap.byElement.get(p)?.style.overflowX;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

/** The month and week calendars on the page. */
export function findCalendars(snap: Snapshot): Calendar[] {
  const found: Calendar[] = [];
  for (const rec of snap.records) {
    const children = renderedChildren(rec.el);
    if (children.length < 7) continue;
    if (found.some((c) => c.root.contains(rec.el))) continue;
    const weekdays = weekRow(snap, children);
    if (!weekdays) continue;

    // The days are in the same grid, or in one beside it: look further up for them.
    let scope: Element | null = rec.el;
    for (let level = 0; scope && level < MAX_LEVELS; level++, scope = composedParent(scope)) {
      if (scope === document.body) break;
      const days = dayCells(snap, scope, weekdays);
      const columns = new Set(days.map((d) => weekdays.findIndex((w) => lined(w, d))));
      if (days.length < 7 || columns.size < 7) continue;
      if (holdsEvents(days)) {
        found.push({ root: scope, weekdays, days, scrolls: scrollsSideways(snap, scope) });
      }
      break;
    }
  }
  return found;
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function inside(root: Element, el: Element | undefined): boolean {
  for (let p: Element | null = el ?? null; p; p = composedParent(p)) if (p === root) return true;
  return false;
}

/**
 * Replaces what breaks inside each calendar with one finding for the calendar. `keep` says
 * whether a calendar may be reported as one (it isn't ignored); when not, its findings stay.
 */
export function foldCalendars(
  snap: Snapshot,
  findings: Finding[],
  keep: (root: Element) => boolean,
): Finding[] {
  const calendars = findCalendars(snap).filter((c) => keep(c.root));
  if (!calendars.length) return findings;
  const folded = new Map<Calendar, Finding[]>();
  const rest: Finding[] = [];
  for (const f of findings) {
    const calendar = FOLDED.has(f.detector)
      ? calendars.find(
          (c) =>
            inside(c.root, elementOf(f.element)) &&
            (!f.related || inside(c.root, elementOf(f.related))),
        )
      : undefined;
    if (!calendar) {
      rest.push(f);
      continue;
    }
    folded.set(calendar, [...(folded.get(calendar) ?? []), f]);
  }
  for (const [calendar, list] of folded) {
    const severity = list.reduce<Severity>(
      (worst, f) => (RANK[f.severity] < RANK[worst] ? f.severity : worst),
      'info',
    );
    const dayWidth = Math.round(Math.min(...calendar.weekdays.map((w) => w.rect.width)) * 10) / 10;
    // One of each kind, as the calendar's evidence: what an agent would otherwise be told.
    const kinds = [...new Map(list.map((f) => [f.detector, f])).values()];
    // Each check's worst severity, so a project's settings for those checks still apply.
    const checks = new Map<DetectorId, Severity>();
    for (const f of list) {
      const was = checks.get(f.detector);
      if (!was || RANK[f.severity] < RANK[was]) checks.set(f.detector, f.severity);
    }
    rest.push({
      detector: 'calendar',
      severity,
      title: "Calendar's 7 days don't fit side by side",
      element: describe(calendar.root),
      evidence: {
        dayWidthPx: dayWidth,
        elementsInside: new Set(list.map((f) => f.element.selector)).size,
        found: kinds.map((f) => `${f.title} at ${f.element.selector}`).join('; '),
        checksInside: [...checks].map(([id, s]) => `${id}:${s}`).join(' '),
        ...(calendar.scrolls ? { scrollsSideways: true } : {}),
      },
      styles: {},
      suggestion:
        "A calendar needs its 7 days side by side, so narrower days or fewer columns won't fix it. Let it scroll sideways inside its own box, or show the days as a list (an agenda view) on small screens.",
      lineage: lineage(calendar.root),
    });
  }
  return rest;
}
