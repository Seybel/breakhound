import type { AnalyzeResult, Toggle } from '@breakhound/analyzers';
import type { Page, Request } from 'playwright';
import { buildIssues, findingKey, INACTIVE } from './issues';
import { settleResize } from './settle';
import { type Measurements, type Prepare, Sweeper, type SweepSettings } from './sweep';
import type { Issue, PageState, ScannedState, WidthRange } from './types';

/** A toggle and the coarse widths where the page, as loaded, shows it. */
export interface StateCandidate {
  toggle: Toggle;
  widths: number[];
}

/**
 * The toggles worth opening: one per group (one question of an FAQ stands for
 * all of them), menus and dialogs first, at most `max`.
 */
export function pickToggles(
  results: Measurements,
  coarse: number[],
  max: number,
): StateCandidate[] {
  const found = new Map<string, StateCandidate & { order: number }>();
  for (const width of coarse) {
    for (const toggle of results.get(width)?.toggles ?? []) {
      const known = found.get(toggle.selector);
      if (known) known.widths.push(width);
      else found.set(toggle.selector, { toggle, widths: [width], order: found.size });
    }
  }
  // One hidden width either side, so sweeping finds the exact width where the toggle appears.
  for (const c of found.values()) {
    const shown = new Set(c.widths);
    c.widths = coarse.filter(
      (w, i) =>
        shown.has(w) || shown.has(coarse[i - 1] as number) || shown.has(coarse[i + 1] as number),
    );
  }
  const groups = new Set<string>();
  return [...found.values()]
    .sort((a, b) => a.toggle.priority - b.toggle.priority || a.order - b.order)
    .filter((c) => {
      if (groups.has(c.toggle.group)) return false;
      groups.add(c.toggle.group);
      return true;
    })
    .slice(0, max)
    .map(({ toggle, widths }) => ({ toggle, widths }));
}

/** "with "Menu" open", for titles and reports. */
export function describeState(state: PageState): string {
  const named = state.label !== state.kind;
  switch (state.kind) {
    case 'dialog':
      return named ? `with the "${state.label}" dialog open` : 'with the dialog open';
    case 'tab':
      return named ? `with the "${state.label}" tab open` : 'with another tab open';
    case 'details':
    case 'disclosure':
      return named ? `with "${state.label}" expanded` : 'with the section expanded';
    default:
      return named ? `with "${state.label}" open` : `with the ${state.kind} open`;
  }
}

/** Thrown when pressing a toggle loaded another page. */
class NavigatedAway extends Error {}

/** Same page, ignoring a #fragment unless it's a hash router's path (#/pricing). */
function samePage(a: string, b: string): boolean {
  const strip = (u: string) => {
    const url = new URL(u);
    if (!/^#[/!]/.test(url.hash)) url.hash = '';
    return url.href;
  };
  return strip(a) === strip(b);
}

/** Opens one toggle, and opens it again whenever a resize closed it. */
class StateDriver {
  /** What the toggle opened, when the page doesn't say (no aria-expanded). Null: nothing. */
  private panel: string | null | undefined;
  private dead = false;
  /** Set when pressing the toggle started loading another page. */
  private leaving = false;
  private readonly watch = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === this.page.mainFrame())
      this.leaving = true;
  };

  constructor(
    private readonly page: Page,
    private readonly toggle: Toggle,
    private readonly home: string,
    private readonly maxSettleMs: number,
  ) {
    page.on('request', this.watch);
  }

  stop(): void {
    this.page.off('request', this.watch);
  }

  private state() {
    return this.page.evaluate(
      (s) => window.__breakhound?.toggleState(s) ?? { shown: false, open: null },
      this.toggle.selector,
    );
  }

  private async isOpen(open: boolean | null): Promise<boolean> {
    if (open !== null) return open;
    if (!this.panel) return false;
    return this.page.evaluate((s) => window.__breakhound?.selectorShown(s) ?? false, this.panel);
  }

  readonly open: Prepare = async () => {
    try {
      return await this.tryOpen();
    } catch (error) {
      // The page went away under us: pressing the toggle navigated.
      if (this.leaving || /context was destroyed|navigat/i.test(String(error)))
        throw new NavigatedAway();
      throw error;
    }
  };

  private async tryOpen(): Promise<boolean> {
    if (this.dead) return false;
    const { shown, open } = await this.state();
    if (!shown) return false;
    if (await this.isOpen(open)) return true;

    const selector = this.toggle.selector;
    const discover = open === null && this.panel === undefined;
    if (this.toggle.kind === 'details') {
      await this.page.evaluate((s) => window.__breakhound?.setDetails(s, true), selector);
    } else {
      if (discover) await this.page.evaluate(() => window.__breakhound?.markShown());
      const point = await this.page.evaluate(
        (s) => window.__breakhound?.clickPoint(s) ?? null,
        selector,
      );
      if (!point) {
        await settleResize(this.page, this.maxSettleMs);
        return false;
      }
      await this.page.mouse.click(point.x, point.y);
    }
    // Menus often open on a timer or after a re-render.
    await this.page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    await settleResize(this.page, this.maxSettleMs);
    if (this.leaving || !samePage(this.page.url(), this.home)) throw new NavigatedAway();

    const after = await this.state();
    if (discover) {
      this.panel = await this.page.evaluate(
        (s) => window.__breakhound?.newlyShown(s) ?? null,
        selector,
      );
    }
    const opened = await this.isOpen(after.open);
    // Pressing it did nothing we can see; pressing it again won't either.
    if (!opened) this.dead = true;
    return opened;
  }
}

function closedAt(
  widths: number[],
  closed: Measurements,
  width: number,
): AnalyzeResult | undefined {
  let best: number | undefined;
  for (const w of widths) {
    if (w > width) break;
    best = w;
  }
  return closed.get(best ?? (widths[0] as number));
}

const wrapKey = (w: AnalyzeResult['wraps'][number]) => `${w.kind}|${w.element.selector}|${w.lines}`;

/** What's wrong only while the state is open: the open measurement minus the page as loaded. */
function withoutClosed(open: AnalyzeResult, closed: AnalyzeResult | undefined): AnalyzeResult {
  if (open.signature === INACTIVE || !closed) return open;
  const findings = new Set(closed.findings.map(findingKey));
  const wraps = new Set(closed.wraps.map(wrapKey));
  return {
    ...open,
    findings: open.findings.filter((f) => !findings.has(findingKey(f))),
    wraps: open.wraps.filter((w) => !wraps.has(wrapKey(w))),
  };
}

function rangesOf(widths: number[], active: (w: number) => boolean): WidthRange[] {
  const out: WidthRange[] = [];
  let open: WidthRange | null = null;
  for (const w of widths) {
    if (!active(w)) {
      open = null;
      continue;
    }
    if (open) open.to = w;
    else {
      open = { from: w, to: w };
      out.push(open);
    }
  }
  return out;
}

export interface StateContext {
  route: string;
  /** Measurements of the page as loaded, to tell what only breaks while open. */
  closed: Measurements;
  settings: SweepSettings;
  /** Loads the page again, so the next state starts from the page as loaded. */
  reload: (page: Page) => Promise<void>;
  confirm: (issues: Issue[], sweeper: Sweeper) => Promise<Issue[]>;
  capture?: (page: Page, issues: Issue[], prepare: Prepare) => Promise<void>;
}

async function scanState(
  page: Page,
  { toggle, widths: coarse }: StateCandidate,
  ctx: StateContext,
): Promise<{ issues: Issue[]; state: ScannedState } | null> {
  const driver = new StateDriver(page, toggle, page.url(), ctx.settings.maxSettleMs);
  const sweeper = new Sweeper(page, ctx.settings, driver.open);
  try {
    await sweeper.run(coarse);
  } catch (error) {
    if (error instanceof NavigatedAway) return null;
    throw error;
  } finally {
    driver.stop();
  }
  const widths = [...sweeper.results.keys()].sort((a, b) => a - b);
  const active = (w: number) => sweeper.results.get(w)?.signature !== INACTIVE;
  if (!widths.some(active)) return null;

  const closedWidths = [...ctx.closed.keys()].sort((a, b) => a - b);
  const filtered = new Map(
    widths.map((w) => [
      w,
      withoutClosed(sweeper.results.get(w) as AnalyzeResult, closedAt(closedWidths, ctx.closed, w)),
    ]),
  );
  const state: PageState = { kind: toggle.kind, label: toggle.label, trigger: toggle.selector };
  const key = `${toggle.kind}:${toggle.selector}`;
  const issues = await ctx.confirm(buildIssues(`${ctx.route}|${key}`, widths, filtered), sweeper);
  const suffix = describeState(state);
  for (const issue of issues) {
    issue.state = state;
    issue.fingerprint = `${issue.fingerprint}|${key}`;
    issue.title = `${issue.title}, ${suffix}`;
  }
  if (ctx.capture && issues.length) {
    await ctx.capture(page, issues, (w) => driver.open(w).catch(() => false));
  }
  return { issues, state: { ...state, ranges: rangesOf(widths, active) } };
}

/**
 * Opens each toggle in turn and scans the widths where it shows, spread over
 * the tabs the page was already measured in. Each tab is loaded again between
 * states, so one state never leaks into the next.
 */
export interface ScannedStates {
  issues: Issue[];
  states: ScannedState[];
}

export async function scanStates(
  pages: Page[],
  candidates: StateCandidate[],
  ctx: StateContext,
): Promise<ScannedStates> {
  const found: { issues: Issue[]; state: ScannedState }[] = [];
  const order = new Map(candidates.map((c, i) => [c, i]));
  const done = new Map<StateCandidate, { issues: Issue[]; state: ScannedState }>();
  let next = 0;
  await Promise.all(
    pages.map(async (page) => {
      // Pressing a toggle can open a new window; it isn't part of this page.
      page.on('popup', (popup) => void popup.close().catch(() => {}));
      let dirty = false;
      for (let c = candidates[next++]; c; c = candidates[next++]) {
        try {
          if (dirty) await ctx.reload(page);
          dirty = true;
          const result = await scanState(page, c, ctx);
          if (result) done.set(c, result);
        } catch {
          // One menu that misbehaves shouldn't cost the page its results.
          if (page.isClosed()) return;
        }
      }
    }),
  );
  for (const c of [...done.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    found.push(done.get(c) as { issues: Issue[]; state: ScannedState });
  }
  return { issues: found.flatMap((f) => f.issues), states: found.map((f) => f.state) };
}
