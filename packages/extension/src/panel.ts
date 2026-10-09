import type { AnalyzeResult } from '@breakhound/analyzers';
import {
  createScanResult,
  type Issue,
  type RouteResult,
  type Severity,
} from '@breakhound/engine/core';
import { DETECTOR_LABELS, formatRange, formatRanges } from '@breakhound/report/format';
import { renderPrompt } from '@breakhound/report/markdown';
import { Cancelled, evaluate, fitScale, setWidth, type Viewport } from './cdp';
import { scanTab, TAB_DEFAULTS } from './scan';
import { TabSession } from './session';

/** Inside DevTools the tab is the inspected one; opened as a page (tests), `?tab=`. */
const inDevtools = typeof chrome.devtools?.inspectedWindow?.tabId === 'number';
const tabId = inDevtools
  ? chrome.devtools.inspectedWindow.tabId
  : Number(new URLSearchParams(location.search).get('tab'));

const session = new TabSession(tabId);

const dark = inDevtools
  ? chrome.devtools.panels.themeName === 'dark'
  : matchMedia('(prefers-color-scheme: dark)').matches;
if (dark) document.documentElement.dataset.theme = 'dark';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  scan: $<HTMLButtonElement>('scan'),
  stop: $<HTMLButtonElement>('stop'),
  min: $<HTMLInputElement>('min'),
  max: $<HTMLInputElement>('max'),
  reload: $<HTMLInputElement>('reload'),
  status: $('status'),
  copyAll: $<HTMLButtonElement>('copy-all'),
  notice: $('notice'),
  noticeText: $('notice-text'),
  noticeClose: $<HTMLButtonElement>('notice-close'),
  intro: $('intro'),
  introScan: $<HTMLButtonElement>('intro-scan'),
  results: $('results'),
  stats: $('stats'),
  viewing: $('viewing'),
  viewingText: $('viewing-text'),
  viewingReset: $<HTMLButtonElement>('viewing-reset'),
  timeline: $('timeline'),
  devices: $('devices'),
  zones: $<HTMLCanvasElement>('zones'),
  axis: $('axis'),
  lanes: $('lanes'),
  hover: $('hover'),
  playhead: $('playhead'),
  filters: $('filters'),
  split: $('split'),
  issues: $('issues'),
  detail: $('detail'),
};

type Filter = 'all' | Severity | 'here';

interface State {
  phase: 'idle' | 'scanning' | 'done';
  stopping: boolean;
  result: RouteResult | null;
  /** Widths the result (or the scan running now) covers; the inputs may have changed since. */
  range: { min: number; max: number };
  startedAt: Date;
  /** What each width measured looked like: its layout, and the worst thing found there. */
  live: Map<number, { layout: string; worst: Severity | null }>;
  /** Where the running scan is. */
  scanAt: number | null;
  measured: number;
  selected: string | null;
  filter: Filter;
  /** The width the tab is shown at, while the panel holds it there. */
  viewing: number | null;
  /** The space the tab has on its own, to zoom wider widths out into. */
  natural: Viewport | null;
  /** Wide enough for the list and the details side by side. */
  wide: boolean;
}

const state: State = {
  phase: 'idle',
  stopping: false,
  result: null,
  range: { min: TAB_DEFAULTS.minWidth, max: TAB_DEFAULTS.maxWidth },
  startedAt: new Date(),
  live: new Map(),
  scanAt: null,
  measured: 0,
  selected: null,
  filter: 'all',
  viewing: null,
  natural: null,
  wide: false,
};

const SEVERITIES: Severity[] = ['error', 'warning', 'info'];
const SEVERITY_NAMES: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};

// ---- small DOM helpers (text only: everything shown can come from the page) ----

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const ICONS = {
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.6V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  check:
    '<path d="M3 8.6l3.2 3.1L13 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  target:
    '<circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>',
  inspect:
    '<path d="M3 2.6l9.4 3.9-4 1.5-1.6 4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 9l3.6 3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  reset:
    '<path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.6v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  close:
    '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  sweep:
    '<path d="M2.5 3.5v9M13.5 3.5v9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5.5 8h5M8.8 6l1.9 2-1.9 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  // Fixed markup from this file, never page content.
  svg.innerHTML = ICONS[name];
  return svg;
}

function label(el: HTMLElement, name: keyof typeof ICONS, text: string): void {
  el.replaceChildren(icon(name), text);
}

function button(
  name: keyof typeof ICONS,
  text: string,
  onClick: (b: HTMLButtonElement) => void,
): HTMLButtonElement {
  const b = h('button', { class: 'btn', type: 'button' });
  label(b, name, text);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

function notify(message: string | null, kind: 'error' | 'note' = 'error'): void {
  ui.notice.hidden = !message;
  ui.notice.classList.toggle('error', kind === 'error');
  ui.noticeText.textContent = message ?? '';
}

// ---- settings, remembered per browser ----

const SETTINGS_KEY = 'breakhound.settings';

function loadSettings(): void {
  let saved: { min?: number; max?: number; reload?: boolean } = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    // Storage blocked or garbled; defaults are fine.
  }
  ui.min.value = String(saved.min ?? TAB_DEFAULTS.minWidth);
  ui.max.value = String(saved.max ?? TAB_DEFAULTS.maxWidth);
  ui.reload.checked = saved.reload ?? false;
}

function saveSettings(): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        min: ui.min.valueAsNumber,
        max: ui.max.valueAsNumber,
        reload: ui.reload.checked,
      }),
    );
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

function readRange(): { min: number; max: number } | null {
  const min = Math.round(ui.min.valueAsNumber);
  const max = Math.round(ui.max.valueAsNumber);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 200 || max > 3840 || max - min < 16) {
    return null;
  }
  return { min, max };
}

// ---- copying ----

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // DevTools panels often can't use the async clipboard; the old way still works there.
    const area = h('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

async function copyWith(b: HTMLButtonElement, text: string): Promise<void> {
  const before = [...b.childNodes];
  const ok = await copyText(text);
  if (b.classList.contains('icon-btn')) b.replaceChildren(icon(ok ? 'check' : 'close'));
  else label(b, ok ? 'check' : 'close', ok ? 'Copied' : 'Could not copy');
  b.classList.add('done');
  setTimeout(() => {
    b.replaceChildren(...before);
    b.classList.remove('done');
  }, 1400);
}

function prompt(fingerprints?: string[]): string {
  const route = state.result as RouteResult;
  const result = createScanResult([route], {
    version: __VERSION__,
    startedAt: state.startedAt,
    minWidth: state.range.min,
    maxWidth: state.range.max,
    step: TAB_DEFAULTS.step,
    baseUrl: new URL(route.url).origin,
  });
  return renderPrompt(result, {
    ...(fingerprints ? { fingerprints, severities: SEVERITIES } : {}),
  });
}

// ---- scanning ----

function worstOf(result: AnalyzeResult): Severity | null {
  for (const s of SEVERITIES) if (result.findings.some((f) => f.severity === s)) return s;
  return null;
}

let frame = 0;
/** Coalesces live updates to one paint per frame, however fast measurements arrive. */
function scheduleLive(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    drawZones();
    renderStats();
    renderPlayhead();
  });
}

async function scan(): Promise<void> {
  const range = readRange();
  if (!range) {
    notify(
      'Pick widths between 200 and 3840px, with the widest at least 16px wider than the narrowest.',
    );
    return;
  }
  saveSettings();
  notify(null);
  await resetView();
  const previous = { result: state.result, range: state.range, live: state.live };
  Object.assign(state, {
    phase: 'scanning',
    stopping: false,
    result: null,
    range,
    live: new Map(),
    scanAt: range.min,
    measured: 0,
    selected: null,
    filter: 'all',
  });
  render();
  const startedAt = new Date();
  let finished = false;
  try {
    await session.attach();
    const result = await scanTab(session, {
      analyzerScript: __ANALYZER_SCRIPT__,
      minWidth: range.min,
      maxWidth: range.max,
      reload: ui.reload.checked,
      onProgress: ({ width, measured }) => {
        state.scanAt = width;
        state.measured = measured;
        scheduleLive();
      },
      onMeasure: (width, r) => {
        state.live.set(width, { layout: r.signature, worst: worstOf(r) });
      },
      cancelled: () => state.stopping,
    });
    state.result = result;
    state.startedAt = startedAt;
    finished = true;
    if (result.status !== 'scanned') notify(result.error ?? 'The page could not be scanned.');
  } catch (error) {
    if (!(error instanceof Cancelled)) {
      const message = error instanceof Error ? error.message : String(error);
      notify(
        /detached|target closed|No tab with given id/i.test(message)
          ? 'The scan stopped because the debugging bar was closed or the tab went away.'
          : `The scan failed: ${message}`,
      );
    }
  } finally {
    await session.detach();
    if (!finished) Object.assign(state, previous);
    state.phase = state.result ? 'done' : 'idle';
    state.scanAt = null;
    render();
  }
}

// ---- holding the tab at a width ----

interface ViewJob {
  width: number;
  /** Wait for the page to catch up, then outline the issue in focus. Off while dragging. */
  settle: boolean;
  focus: Issue | null;
  scroll: boolean;
}

let pending: ViewJob | null = null;
let pumping = false;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shows the page at `width`. Requests made while one is on its way replace
 * each other, so dragging across the timeline never queues up behind the tab.
 */
function view(
  width: number,
  opts: { settle?: boolean; focus?: Issue | null; scroll?: boolean } = {},
): void {
  const w = Math.max(state.range.min, Math.min(state.range.max, Math.round(width)));
  state.viewing = w;
  pending = {
    width: w,
    settle: opts.settle ?? true,
    focus: opts.focus ?? null,
    scroll: !!opts.scroll,
  };
  renderPlayhead();
  renderViewing();
  if (!pumping) void pump();
}

async function pump(): Promise<void> {
  pumping = true;
  try {
    while (pending) {
      const job: ViewJob = pending;
      pending = null;
      if (!session.isAttached) {
        await session.attach();
        // Chrome's debugging bar takes some of the tab's height as it appears.
        await pause(200);
        state.natural = await evaluate<Viewport>(session, () => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        renderViewing();
      }
      await setWidth(session, job.width, 0, state.natural ?? undefined);
      if (job.settle && !pending) await settle(job);
    }
  } catch (error) {
    pending = null;
    notify(error instanceof Error ? error.message : String(error));
    await session.detach();
    state.viewing = null;
    renderPlayhead();
    renderViewing();
  } finally {
    pumping = false;
  }
}

/** Once the page has caught up with a width: outline the issue in focus if it shows there. */
async function settle(job: ViewJob): Promise<void> {
  // A reload since the scan takes the analyzers with it.
  const present = await evaluate<boolean>(session, () => !!window.__breakhound);
  if (!present) await evaluate(session, __ANALYZER_SCRIPT__);
  await evaluate(session, () => window.__breakhound?.settleAfterResize(1000));
  const issue = job.focus ?? selectedIssue();
  if (!issue || !activeAt(issue, job.width)) {
    await evaluate(session, () => window.__breakhound?.clearHighlights());
    return;
  }
  const found = await evaluate<boolean>(
    session,
    (o: { selector: string; related: string | null; edge: boolean; scroll: boolean }) => {
      const api = window.__breakhound;
      if (!api) return false;
      api.clearHighlights();
      const el = api.resolveSelector(o.selector);
      if (!el) return false;
      if (o.scroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      api.highlight({
        selector: o.selector,
        related: o.related,
        showEdge: o.edge,
        pad: 0,
        maxHeight: 100_000,
      });
      return true;
    },
    {
      selector: issue.element.selector,
      related: issue.related?.selector ?? null,
      edge: issue.detector === 'page-overflow',
      scroll: job.scroll,
    },
  );
  if (!found && job.scroll) {
    notify(
      "That element isn't on the page right now. It may only appear after something else happens, like opening a menu.",
      'note',
    );
  }
}

/** Gives the tab its own width back and lets go of it. */
async function resetView(): Promise<void> {
  pending = null;
  while (pumping) await pause(20);
  if (session.isAttached) {
    await evaluate(session, () => window.__breakhound?.clearHighlights()).catch(() => {});
    await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await session.detach();
  }
  state.viewing = null;
  state.natural = null;
  renderPlayhead();
  renderViewing();
  if (state.phase === 'done') renderIssues();
}

/** Selects the element in the Elements panel. */
function inspect(issue: Issue): void {
  const selector = JSON.stringify(issue.element.selector);
  chrome.devtools.inspectedWindow.eval(
    `inspect(window.__breakhound ? window.__breakhound.resolveSelector(${selector}) : document.querySelector(${selector}))`,
  );
}

// ---- issue helpers ----

function activeAt(issue: Issue, width: number): boolean {
  return issue.ranges.some((r) => width >= r.from && width <= r.to);
}

function selectedIssue(): Issue | null {
  return state.result?.issues.find((i) => i.id === state.selected) ?? null;
}

function visibleIssues(): Issue[] {
  const issues = state.result?.issues ?? [];
  const f = state.filter;
  if (f === 'all') return issues;
  if (f === 'here') {
    const at = state.viewing;
    return at === null ? issues : issues.filter((i) => activeAt(i, at));
  }
  return issues.filter((i) => i.severity === f);
}

function select(issue: Issue | null, width?: number): void {
  state.selected = issue?.id ?? null;
  renderIssues();
  renderLanes();
  if (issue) view(width ?? issue.worstAt, { focus: issue, scroll: true });
}

// ---- rendering: header and stats ----

function renderToolbar(): void {
  const scanning = state.phase === 'scanning';
  label(ui.scan, 'sweep', state.result ? 'Scan again' : 'Scan');
  ui.scan.disabled = scanning;
  ui.stop.hidden = !scanning;
  ui.stop.disabled = state.stopping;
  label(ui.stop, 'stop', state.stopping ? 'Stopping' : 'Stop');
  ui.min.disabled = scanning;
  ui.max.disabled = scanning;
  ui.reload.disabled = scanning;
  ui.copyAll.hidden = scanning || !state.result?.issues.some((i) => i.severity !== 'info');
}

function stat(name: string, value: Child, sub: Child, cls = ''): HTMLElement {
  return h(
    'div',
    { class: `stat ${cls}` },
    h('div', { class: 'label' }, name),
    h('div', { class: 'value' }, value),
    h('div', { class: 'sub' }, sub),
  );
}

function liveCounts(): { layouts: number; problems: number } {
  let layouts = 0;
  let problems = 0;
  let last: string | null = null;
  for (const w of [...state.live.keys()].sort((a, b) => a - b)) {
    const m = state.live.get(w);
    if (!m) continue;
    if (m.layout !== last) layouts++;
    last = m.layout;
    if (m.worst) problems++;
  }
  return { layouts, problems };
}

function renderStats(): void {
  const { min, max } = state.range;
  if (state.phase === 'scanning') {
    const at = state.scanAt ?? min;
    const pct = Math.max(0, Math.min(100, Math.round(((at - min) / (max - min)) * 100)));
    const { layouts, problems } = liveCounts();
    ui.status.textContent = `Scanning · ${pct}%`;
    ui.stats.replaceChildren(
      stat('Measuring', `${at}px`, `${pct}% of the way to ${max}px`),
      stat('Widths measured', String(state.measured), 'each change narrowed to the pixel'),
      stat('Layouts so far', String(layouts), 'runs of widths that share a layout'),
      stat(
        'Something breaks at',
        String(problems),
        problems === 1 ? 'width so far' : 'widths so far',
      ),
    );
    return;
  }
  ui.status.textContent = '';
  const r = state.result;
  if (!r) return;
  const bp = r.breakpoints;
  const url = new URL(r.url);
  ui.stats.replaceChildren(
    stat(
      'Issues',
      String(r.issues.length),
      h(
        'span',
        { class: 'sevs' },
        ...SEVERITIES.flatMap((s) => {
          const n = r.issues.filter((i) => i.severity === s).length;
          return n ? [h('span', {}, h('i', { class: `dot ${s}` }), `${n} ${s}`)] : [];
        }),
        r.issues.length ? null : 'nothing breaks',
      ),
    ),
    stat(
      'Layout changes',
      String(bp.observed.length),
      bp.unexplained.length
        ? `${bp.unexplained.length} with no media or container query`
        : bp.observed.length
          ? 'all at media or container queries'
          : 'one layout at every width',
    ),
    stat(
      'Widths measured',
      String(r.measurements),
      `${min}–${max}px in ${(r.durationMs / 1000).toFixed(1)}s`,
    ),
    stat('Page', url.pathname + url.hash, url.host, 'page'),
  );
}

// ---- rendering: timeline ----

function x(width: number): number {
  const { min, max } = state.range;
  return ((width - min) / (max - min)) * 100;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Bands of widths that share a layout, and where something breaks, drawn as measurements come in. */
function drawZones(): void {
  const canvas = ui.zones;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const ht = canvas.clientHeight;
  if (!w || !ht) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(ht * dpr);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, ht);
  g.save();
  g.beginPath();
  g.roundRect(0, 0, w, ht, 4);
  g.clip();
  g.fillStyle = cssVar('--surface');
  g.fillRect(0, 0, w, ht);

  const colors: Record<string, string> = {
    a: cssVar('--zone-a'),
    b: cssVar('--zone-b'),
    change: cssVar('--change'),
    unexplained: cssVar('--unexplained'),
    error: cssVar('--error'),
    warning: cssVar('--warning'),
    info: cssVar('--info'),
  };
  const px = (width: number) => Math.round((x(width) / 100) * w);
  const unexplained = new Set(state.result?.breakpoints.unexplained ?? []);
  const end = state.phase === 'scanning' ? (state.scanAt ?? state.range.min) : state.range.max;
  const widths = [...state.live.keys()].sort((a, b) => a - b);
  const bands = ht - 6;

  // Runs of widths with one layout, and runs with the same worst problem, each drawn as one shape.
  const zones: { from: number; to: number; layout: string }[] = [];
  const problems: { from: number; to: number; worst: Severity }[] = [];
  for (let i = 0; i < widths.length; i++) {
    const width = widths[i] as number;
    const m = state.live.get(width);
    if (!m) continue;
    const to = widths[i + 1] ?? Math.max(width, end);
    const zone = zones[zones.length - 1];
    if (zone && zone.layout === m.layout) zone.to = to;
    else zones.push({ from: width, to, layout: m.layout });
    // Once scanned, the issues say it best: they include wrapped rows, and leave out what the design does on purpose.
    const worst = state.result ? worstIssueAt(width) : m.worst;
    const problem = problems[problems.length - 1];
    if (worst && problem && problem.worst === worst && problem.to === width) problem.to = to;
    else if (worst) problems.push({ from: width, to, worst });
  }
  zones.forEach((zone, i) => {
    g.fillStyle = (i % 2 ? colors.b : colors.a) as string;
    g.fillRect(px(zone.from), 0, Math.max(1, px(zone.to) - px(zone.from)), bands);
    if (i === 0) return;
    const odd = unexplained.has(zone.from);
    g.fillStyle = (odd ? colors.unexplained : colors.change) as string;
    g.fillRect(px(zone.from) - (odd ? 1 : 0), 0, odd ? 2 : 1, bands);
  });
  for (const p of problems) {
    g.fillStyle = colors[p.worst] as string;
    g.fillRect(px(p.from), ht - 4, Math.max(2, px(p.to) - px(p.from)), 4);
  }
  g.restore();
}

function worstIssueAt(width: number): Severity | null {
  const here = state.result?.issues.filter((i) => activeAt(i, width)) ?? [];
  return SEVERITIES.find((s) => here.some((i) => i.severity === s)) ?? null;
}

/** A round number of pixels between axis labels that keeps them apart. */
function labelStep(): number {
  const span = state.range.max - state.range.min;
  const width = ui.timeline.clientWidth || 600;
  for (const step of [50, 100, 200, 250, 500, 1000]) {
    if ((step / span) * width >= 64) return step;
  }
  return 2000;
}

function renderAxis(): void {
  const { min, max } = state.range;
  const step = labelStep();
  const items: Node[] = [h('span', { class: 'label start', style: 'left:0' }, `${min}`)];
  for (let w = Math.ceil((min + 1) / step) * step; w < max; w += step) {
    if (x(w) < 5 || x(w) > 95) continue;
    items.push(h('span', { class: 'tick', style: `left:${x(w)}%` }));
    items.push(h('span', { class: 'label', style: `left:${x(w)}%` }, `${w}`));
  }
  items.push(h('span', { class: 'label end', style: 'left:100%' }, `${max}`));
  const bp = state.phase === 'done' ? state.result?.breakpoints : undefined;
  for (const w of bp?.declared ?? []) {
    items.push(
      h('span', { class: 'declared', style: `left:${x(w)}%`, title: `Media query at ${w}px` }),
    );
  }
  for (const w of bp?.unexplained ?? []) {
    items.push(
      h('span', {
        class: 'unexplained',
        style: `left:${x(w)}%`,
        title: `The layout changes at ${w}px with no media or container query there`,
      }),
    );
  }
  ui.axis.replaceChildren(...items);

  const devices = [
    { width: 375, name: 'Phone' },
    { width: 768, name: 'Tablet' },
    { width: 1280, name: 'Laptop' },
    { width: 1536, name: 'Desktop' },
  ];
  const total = ui.timeline.clientWidth || 600;
  let lastPct = Number.NEGATIVE_INFINITY;
  const shown: Node[] = [];
  for (const d of devices) {
    const pct = x(d.width);
    if (pct < 4 || pct > 96 || ((pct - lastPct) / 100) * total < 56) continue;
    lastPct = pct;
    shown.push(h('span', { style: `left:${pct}%`, title: `${d.width}px` }, d.name));
  }
  ui.devices.replaceChildren(...shown);
}

/** Issues packed into as few rows as fit, each a bar per width range. */
function renderLanes(): void {
  const issues = state.phase === 'done' ? visibleIssues() : [];
  const rows: { end: number; issues: Issue[] }[] = [];
  const sorted = [...issues].sort((a, b) => (a.ranges[0]?.from ?? 0) - (b.ranges[0]?.from ?? 0));
  const gap = (state.range.max - state.range.min) * 0.01;
  for (const issue of sorted) {
    const from = issue.ranges[0]?.from ?? 0;
    const to = issue.ranges[issue.ranges.length - 1]?.to ?? from;
    let row = rows.find((r) => r.end + gap < from);
    if (!row) {
      row = { end: to, issues: [] };
      rows.push(row);
    }
    row.end = to;
    row.issues.push(issue);
  }
  ui.lanes.classList.toggle('focus', !!state.selected);
  ui.lanes.replaceChildren(
    ...rows.map((row) =>
      h(
        'div',
        { class: 'lane' },
        ...row.issues.flatMap((issue) =>
          issue.ranges.map((r) =>
            h('span', {
              class: `lane-bar ${issue.severity}${issue.id === state.selected ? ' selected' : ''}`,
              style: `left:${x(r.from)}%;width:${Math.max(0, x(r.to) - x(r.from))}%`,
              title: `${issue.title} · ${formatRange(r)}`,
              'data-id': issue.id,
            }),
          ),
        ),
      ),
    ),
  );
}

function placeLine(line: HTMLElement, width: number, text: string): void {
  const pct = x(width);
  line.style.left = `${pct}%`;
  line.classList.toggle('left', pct < 4);
  line.classList.toggle('right', pct > 96);
  (line.firstElementChild as HTMLElement).textContent = text;
}

function renderPlayhead(): void {
  const scanning = state.phase === 'scanning';
  const width = scanning ? state.scanAt : state.viewing;
  ui.timeline.classList.toggle('scanning', scanning);
  ui.playhead.hidden = width === null;
  if (width !== null) placeLine(ui.playhead, width, `${width}px`);
  ui.timeline.setAttribute('aria-valuemin', String(state.range.min));
  ui.timeline.setAttribute('aria-valuemax', String(state.range.max));
  ui.timeline.setAttribute('aria-valuenow', String(state.viewing ?? state.range.min));
  ui.timeline.setAttribute(
    'aria-valuetext',
    state.viewing === null ? 'The tab is at its own width' : `${state.viewing}px`,
  );
}

function renderViewing(): void {
  const w = state.viewing;
  ui.viewing.hidden = w === null || state.phase === 'scanning';
  if (w !== null) {
    const scale = fitScale(w, state.natural ?? undefined);
    ui.viewingText.textContent =
      scale < 1 ? `Showing ${w}px, zoomed to ${Math.round(scale * 100)}% to fit` : `Showing ${w}px`;
  }
  // The "here" filter and markers follow the width.
  if (state.phase === 'done') {
    renderFilters();
    markHere();
  }
}

function renderTimeline(): void {
  renderAxis();
  renderLanes();
  drawZones();
  renderPlayhead();
  renderViewing();
}

// ---- rendering: list and detail ----

function renderFilters(): void {
  const r = state.result;
  if (!r || state.phase !== 'done' || !r.issues.length) {
    ui.filters.replaceChildren();
    return;
  }
  if (state.filter === 'here' && state.viewing === null) state.filter = 'all';
  const chip = (f: Filter, text: string, n: number, dot?: string) => {
    const b = h(
      'button',
      { class: 'chip', type: 'button', 'aria-pressed': String(state.filter === f) },
      dot ? h('i', { class: `dot ${dot}` }) : null,
      text,
      h('span', { class: 'count' }, String(n)),
    );
    b.addEventListener('click', () => {
      state.filter = f;
      renderFilters();
      renderIssues();
      renderLanes();
    });
    return b;
  };
  const chips = [chip('all', 'All', r.issues.length)];
  for (const s of SEVERITIES) {
    const n = r.issues.filter((i) => i.severity === s).length;
    if (n) chips.push(chip(s, `${SEVERITY_NAMES[s]}s`, n, s));
  }
  const at = state.viewing;
  if (at !== null) {
    chips.push(chip('here', `At ${at}px`, r.issues.filter((i) => activeAt(i, at)).length, 'here'));
  }
  ui.filters.replaceChildren(...chips);
}

function markHere(): void {
  if (state.filter === 'here') {
    renderIssues();
    return;
  }
  for (const li of ui.issues.querySelectorAll<HTMLElement>('.issue')) {
    const issue = state.result?.issues.find((i) => i.id === li.dataset.id);
    li.classList.toggle(
      'here',
      !!issue && state.viewing !== null && activeAt(issue, state.viewing),
    );
  }
}

function issueRow(issue: Issue): HTMLLIElement {
  const selected = issue.id === state.selected;
  const head = h(
    'button',
    { class: 'issue-head', type: 'button', 'aria-expanded': String(selected) },
    h('i', { class: `dot ${issue.severity}` }),
    h(
      'span',
      { class: 'issue-title' },
      issue.title,
      ' ',
      h('span', { class: 'here-tag' }, 'at this width'),
    ),
    h('span', { class: 'ranges' }, formatRanges(issue.ranges)),
    h(
      'span',
      { class: 'issue-meta' },
      h('span', {}, DETECTOR_LABELS[issue.detector]),
      h('code', {}, issue.element.selector),
    ),
  );
  head.addEventListener('click', () => select(selected ? null : issue));
  const here = state.viewing !== null && activeAt(issue, state.viewing);
  const li = h(
    'li',
    {
      class: `issue${selected ? ' selected' : ''}${here ? ' here' : ''}`,
      'data-id': issue.id,
    },
    head,
  );
  if (selected && !state.wide) li.append(detailFor(issue));
  return li;
}

function evidenceRows(issue: Issue): Node[] {
  const rows: Node[] = [];
  for (const [key, value] of Object.entries(issue.evidence)) {
    const name = key.replace(/([A-Z])/g, ' $1').toLowerCase();
    const text =
      typeof value === 'number' && /px|width|height|overflow/i.test(key)
        ? `${value}px`
        : String(value);
    rows.push(
      h('dt', {}, `${name.charAt(0).toUpperCase()}${name.slice(1)}`),
      h('dd', { class: 'num' }, text),
    );
  }
  return rows;
}

function detailFor(issue: Issue): HTMLElement {
  const copySelector = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Copy selector',
    'aria-label': 'Copy selector',
  });
  copySelector.append(icon('copy'));
  copySelector.addEventListener('click', () => void copyWith(copySelector, issue.element.selector));

  return h(
    'div',
    { class: 'detail' },
    h(
      'div',
      { class: 'badges' },
      h('span', { class: `badge ${issue.severity}` }, SEVERITY_NAMES[issue.severity]),
      h('span', { class: 'badge' }, DETECTOR_LABELS[issue.detector]),
    ),
    h('h2', {}, issue.title),
    h(
      'div',
      { class: 'range-chips' },
      ...issue.ranges.map((r) => {
        const b = h(
          'button',
          { class: 'range-chip', type: 'button', title: `Show the page at ${r.from}px` },
          formatRange(r),
        );
        b.addEventListener('click', () => view(r.from, { focus: issue, scroll: true }));
        return b;
      }),
      h('span', {}, `worst at ${issue.worstAt}px`),
    ),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Element'),
      h('dd', {}, h('code', {}, issue.element.selector), copySelector),
      issue.related && h('dt', {}, 'Together with'),
      issue.related && h('dd', {}, h('code', {}, issue.related.selector)),
      issue.element.text && h('dt', {}, 'Text'),
      issue.element.text && h('dd', {}, `“${issue.element.text}”`),
      ...evidenceRows(issue),
    ),
    issue.suggestion &&
      h('div', { class: 'fix' }, h('h3', {}, 'Likely fix'), h('p', {}, issue.suggestion)),
    h(
      'div',
      { class: 'actions' },
      button('target', `Show at ${issue.worstAt}px`, () =>
        view(issue.worstAt, { focus: issue, scroll: true }),
      ),
      inDevtools && button('inspect', 'Select in Elements', () => inspect(issue)),
      button('copy', 'Copy prompt', (b) => void copyWith(b, prompt([issue.fingerprint]))),
    ),
  );
}

/** What the side shows with no issue picked: where the layout changes, to jump to. */
function overview(): HTMLElement {
  const r = state.result as RouteResult;
  const bp = r.breakpoints;
  const unexplained = new Set(bp.unexplained);
  return h(
    'div',
    { class: 'detail' },
    h('h3', {}, 'Layout changes'),
    bp.observed.length
      ? h(
          'div',
          { class: 'changes' },
          ...bp.observed.map((w) => {
            const odd = unexplained.has(w);
            const b = h(
              'button',
              {
                class: `range-chip${odd ? ' unexplained' : ''}`,
                type: 'button',
                title: odd ? 'No media or container query here' : 'At a media or container query',
              },
              `${w}px`,
            );
            b.addEventListener('click', () => view(w));
            return b;
          }),
        )
      : h('p', { class: 'muted' }, 'The layout is the same at every width.'),
    h(
      'p',
      { class: 'muted' },
      r.issues.length
        ? 'Pick an issue to see the page at the width where it is worst, with the element outlined.'
        : 'Drag across the timeline to watch the page at any width.',
    ),
  );
}

function renderIssues(): void {
  ui.split.classList.toggle('wide', state.wide && state.phase === 'done');
  if (state.phase === 'scanning') {
    ui.issues.replaceChildren(
      h(
        'li',
        { class: 'empty-list' },
        h('strong', {}, 'Sweeping…'),
        'Issues are listed as soon as every width is measured.',
      ),
    );
    ui.detail.hidden = true;
    return;
  }
  const r = state.result;
  if (!r) return;
  const issues = visibleIssues();
  if (!r.issues.length) {
    ui.issues.replaceChildren(
      h(
        'li',
        { class: 'empty-list' },
        h('strong', {}, 'Nothing breaks.'),
        `No issues between ${state.range.min}px and ${state.range.max}px.`,
      ),
    );
  } else if (!issues.length) {
    ui.issues.replaceChildren(h('li', { class: 'empty-list' }, 'Nothing here with this filter.'));
  } else {
    ui.issues.replaceChildren(...issues.map(issueRow));
  }
  ui.detail.hidden = !state.wide;
  if (state.wide) {
    const selected = selectedIssue();
    ui.detail.replaceChildren(...(selected ? detailFor(selected) : overview()).childNodes);
  }
}

function render(): void {
  document.body.dataset.phase = state.phase;
  const showResults = state.phase === 'scanning' || state.result?.status === 'scanned';
  ui.intro.hidden = showResults;
  ui.results.hidden = !showResults;
  renderToolbar();
  if (!showResults) return;
  renderStats();
  renderFilters();
  renderIssues();
  renderTimeline();
}

// ---- timeline pointer and keys ----

function widthAt(clientX: number): number {
  const box = ui.timeline.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  const { min, max } = state.range;
  return Math.round(min + frac * (max - min));
}

let dragging = false;

ui.timeline.addEventListener('pointerdown', (e) => {
  if (state.phase !== 'done' || e.button !== 0) return;
  const width = widthAt(e.clientX);
  const bar = (e.target as HTMLElement).closest<HTMLElement>('.lane-bar');
  const issue = bar ? state.result?.issues.find((i) => i.id === bar.dataset.id) : undefined;
  if (issue) {
    // Show the issue where it was clicked, which is inside one of its ranges.
    select(issue, activeAt(issue, width) ? width : issue.worstAt);
    return;
  }
  dragging = true;
  ui.timeline.setPointerCapture(e.pointerId);
  ui.hover.hidden = true;
  view(width, { settle: false });
});

ui.timeline.addEventListener('pointermove', (e) => {
  if (state.phase !== 'done') return;
  const width = widthAt(e.clientX);
  if (dragging) {
    view(width, { settle: false });
    return;
  }
  ui.hover.hidden = false;
  placeLine(ui.hover, width, `${width}px`);
});

const endDrag = (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  ui.timeline.releasePointerCapture(e.pointerId);
  view(widthAt(e.clientX));
};
ui.timeline.addEventListener('pointerup', endDrag);
ui.timeline.addEventListener('pointercancel', endDrag);
ui.timeline.addEventListener('pointerleave', () => {
  ui.hover.hidden = true;
});

let keyTimer: ReturnType<typeof setTimeout> | undefined;
ui.timeline.addEventListener('keydown', (e) => {
  if (state.phase !== 'done') return;
  const from = state.viewing ?? state.natural?.width ?? state.range.min;
  const step = e.shiftKey ? 10 : 1;
  let to: number | null = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = from + step;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = from - step;
  else if (e.key === 'Home') to = state.range.min;
  else if (e.key === 'End') to = state.range.max;
  else if (e.key === 'Escape') {
    void resetView();
    return;
  } else return;
  e.preventDefault();
  view(to, { settle: false });
  // Outline the issue once the keys stop.
  clearTimeout(keyTimer);
  keyTimer = setTimeout(() => {
    if (state.viewing !== null) view(state.viewing);
  }, 250);
});

ui.issues.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const heads = [...ui.issues.querySelectorAll<HTMLElement>('.issue-head')];
  const at = heads.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  e.preventDefault();
  heads[Math.max(0, Math.min(heads.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
});

// ---- wiring ----

label(ui.introScan, 'sweep', 'Scan this page');
label(ui.copyAll, 'copy', 'Copy prompt');
label(ui.viewingReset, 'reset', 'Back to its own width');
ui.noticeClose.append(icon('close'));

ui.scan.addEventListener('click', () => void scan());
ui.introScan.addEventListener('click', () => void scan());
ui.stop.addEventListener('click', () => {
  state.stopping = true;
  renderToolbar();
});
ui.viewingReset.addEventListener('click', () => void resetView());
ui.noticeClose.addEventListener('click', () => notify(null));
ui.copyAll.addEventListener('click', () => void copyWith(ui.copyAll, prompt()));
for (const input of [ui.min, ui.max, ui.reload]) input.addEventListener('change', saveSettings);

session.onDetach = () => {
  // The developer closed the debugging bar, or the tab went away.
  state.stopping = state.phase === 'scanning';
  pending = null;
  state.viewing = null;
  state.natural = null;
  renderPlayhead();
  renderViewing();
};

if (inDevtools) {
  chrome.devtools.network.onNavigated.addListener(() => {
    if (state.phase === 'scanning') return;
    void resetView();
    if (state.result) {
      notify('The page changed since this scan. Scan again to see where it stands now.', 'note');
    }
  });
}

// Lay out again when DevTools is resized: the side-by-side view and the axis labels depend on it.
const WIDE_AT = 760;
new ResizeObserver(() => {
  const wide = document.body.clientWidth - 24 >= WIDE_AT;
  if (wide !== state.wide) {
    state.wide = wide;
    if (state.phase === 'done') renderIssues();
  }
  if (!ui.results.hidden) {
    renderAxis();
    drawZones();
  }
}).observe(document.body);

// Leave the tab as it was when DevTools closes.
addEventListener('pagehide', () => {
  if (session.isAttached) void session.detach();
});

loadSettings();
state.wide = document.body.clientWidth - 24 >= WIDE_AT;
render();
