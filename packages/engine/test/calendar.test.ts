import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { type Issue, Scanner } from '../src/index';

const PAGES = join(import.meta.dirname, '../../../fixtures/pages');
const dir = mkdtempSync(join(tmpdir(), 'breakhound-calendar-'));
const scanner = new Scanner();

afterAll(() => scanner.close());

const EVENTS = ['09:00 Team standup', '13:30 Design review', '16:00 Weekly planning'];

/**
 * A page with a calendar of these column headings over 35 days, each day with events that
 * never wrap, so its days run out of room on small screens.
 */
function calendarPage(
  headings: string[],
  options: { lang?: string; css?: string; attrs?: string; wrap?: (grid: string) => string } = {},
): string {
  const days = Array.from(
    { length: 35 },
    (_, d) =>
      `<div class="day"><span>${(d % 31) + 1}</span>${d % 2 ? '' : `<a href="#" class="event">${EVENTS[d % 3]}</a>`}</div>`,
  ).join('');
  const grid = `<div class="month" ${options.attrs ?? ''}>${headings.map((h) => `<div class="weekday">${h}</div>`).join('')}${days}</div>`;
  return `<!doctype html><html lang="${options.lang ?? 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
* { box-sizing: border-box; } body { margin: 0; font: 16px/1.4 Arial, Helvetica, sans-serif; } main { padding: 16px; }
.month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.weekday { padding: 6px 2px; font-size: 13px; font-weight: bold; }
.day { min-height: 100px; padding: 4px; border-top: 1px solid #eee; }
.event { display: block; font-size: 12px; white-space: nowrap; color: #224; background: #eef; }
${options.css ?? ''}
</style></head><body><main>${options.wrap ? options.wrap(grid) : grid}</main></body></html>`;
}

let pages = 0;
async function scan(html: string): Promise<Issue[]> {
  const file = join(dir, `page-${pages++}.html`);
  writeFileSync(file, html);
  const result = await scanner.scanPage(pathToFileURL(file).href, {
    minWidth: 320,
    maxWidth: 1000,
    states: 0,
  });
  expect(result.status, result.error).toBe('scanned');
  return result.issues;
}

const ENGLISH = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

describe('a calendar whose days run out of room', () => {
  it('is one issue, with a fix for calendars from the width where it starts to fit', async () => {
    const url = pathToFileURL(join(PAGES, 'bug-calendar-grid.html')).href;
    const result = await scanner.scanPage(url, { minWidth: 320, maxWidth: 1440, states: 0 });
    expect(result.issues.map((i) => i.detector)).toEqual(['calendar']);
    const [calendar] = result.issues;
    expect(calendar?.worstAt).toBe(320);
    expect(calendar?.suggestion).toContain('below 872px');
    expect(calendar?.suggestion).toContain('scroll sideways inside its own box');
    expect(calendar?.suggestion).toContain('as a list');
    // Not the fix for one element that won't shrink, which would squeeze the days.
    expect(calendar?.suggestion).not.toContain('max-width: 100%');
    // What was found inside it stays in the evidence.
    expect(calendar?.evidence.found).toMatch(/Page scrolls horizontally/);
  });

  it("is recognised in the page's language, with dates in the headings, or one letter a day", async () => {
    const french = await scan(
      calendarPage(['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'], { lang: 'fr' }),
    );
    expect(french.map((i) => i.detector)).toContain('calendar');
    // A week view, Sunday first.
    const week = await scan(
      calendarPage(['Sun 12', 'Mon 13', 'Tue 14', 'Wed 15', 'Thu 16', 'Fri 17', 'Sat 18']),
    );
    expect(week.map((i) => i.detector)).toContain('calendar');
    const letters = await scan(calendarPage(['S', 'M', 'T', 'W', 'T', 'F', 'S']));
    expect(letters.map((i) => i.detector)).toContain('calendar');
  });

  it('says how to fix one that already scrolls sideways', async () => {
    const issues = await scan(
      calendarPage(ENGLISH, {
        wrap: (grid) => `<div style="overflow-x: auto">${grid}</div>`,
      }),
    );
    const calendar = issues.find((i) => i.detector === 'calendar');
    expect(calendar?.evidence.scrollsSideways).toBe(true);
    expect(calendar?.suggestion).toMatch(/^It already scrolls sideways/);
  });
});

describe('what is not a calendar', () => {
  it('leaves a row of 7 other things, or 7 weekdays out of order, as they were', async () => {
    const other = await scan(
      calendarPage(['Home', 'Shop', 'Blog', 'About', 'Help', 'Jobs', 'Press']),
    );
    expect(other.length).toBeGreaterThan(0);
    expect(other.map((i) => i.detector)).not.toContain('calendar');
    const shuffled = await scan(calendarPage(['Mon', 'Wed', 'Tue', 'Thu', 'Fri', 'Sat', 'Sun']));
    expect(shuffled.map((i) => i.detector)).not.toContain('calendar');
  });

  it('reports what breaks inside one the developer said to ignore as a calendar', async () => {
    const issues = await scan(
      calendarPage(ENGLISH, { attrs: 'data-breakhound-ignore="calendar"' }),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.detector)).not.toContain('calendar');
  });
});
