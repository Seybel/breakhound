import { createScanResult, type Issue, type RouteResult } from '@breakhound/engine/core';
import { DETECTOR_LABELS, evidenceText, formatRanges } from '@breakhound/report/format';
import { renderPrompt } from '@breakhound/report/markdown';
import { Cancelled, evaluate, setWidth } from './cdp';
import { scanTab, TAB_DEFAULTS } from './scan';
import { TabSession } from './session';

/** Inside DevTools the tab is the inspected one; opened as a page (tests), `?tab=`. */
const inDevtools = typeof chrome.devtools?.inspectedWindow?.tabId === 'number';
const tabId = inDevtools
  ? chrome.devtools.inspectedWindow.tabId
  : Number(new URLSearchParams(location.search).get('tab'));

const session = new TabSession(tabId);

if (inDevtools && chrome.devtools.panels.themeName === 'dark') {
  document.documentElement.dataset.theme = 'dark';
} else if (!inDevtools && matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.dataset.theme = 'dark';
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  scan: $<HTMLButtonElement>('scan'),
  stop: $<HTMLButtonElement>('stop'),
  min: $<HTMLInputElement>('min'),
  max: $<HTMLInputElement>('max'),
  reload: $<HTMLInputElement>('reload'),
  status: $('status'),
  copyAll: $<HTMLButtonElement>('copy-all'),
  stale: $('stale'),
  error: $('error'),
  preview: $('preview'),
  previewText: $('preview-text'),
  previewEnd: $<HTMLButtonElement>('preview-end'),
  intro: $('intro'),
  results: $('results'),
  summary: $('summary'),
  timeline: $('timeline'),
  axis: $('axis'),
  lanes: $('lanes'),
  cursor: $('cursor'),
  now: $('now'),
  issues: $('issues'),
};

interface State {
  scanning: boolean;
  stopping: boolean;
  result: RouteResult | null;
  /** Widths the result was scanned between (the inputs may have changed since). */
  range: { min: number; max: number };
  startedAt: Date;
  selected: string | null;
  previewWidth: number | null;
}

const state: State = {
  scanning: false,
  stopping: false,
  result: null,
  range: { min: TAB_DEFAULTS.minWidth, max: TAB_DEFAULTS.maxWidth },
  startedAt: new Date(),
  selected: null,
  previewWidth: null,
};

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

// ---- DOM helpers (text only: everything shown comes from the page) ----

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; title?: string; style?: string; type?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.title) el.title = props.title;
  if (props.style) el.setAttribute('style', props.style);
  if (props.type) el.setAttribute('type', props.type);
  for (const c of children) if (c) el.append(c);
  return el;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = h('button', { type: 'button' }, label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

function showError(message: string | null): void {
  ui.error.hidden = !message;
  ui.error.textContent = message ?? '';
}

// ---- copying ----

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // DevTools panels often can't use the async clipboard; the old way still works there.
    const area = h('textarea');
    area.value = text;
    area.setAttribute('style', 'position:fixed;opacity:0');
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function flash(b: HTMLButtonElement, text: string): void {
  const before = b.textContent;
  b.textContent = text;
  setTimeout(() => {
    b.textContent = before;
  }, 1500);
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
    ...(fingerprints ? { fingerprints, severities: ['error', 'warning', 'info'] } : {}),
  });
}

// ---- scanning ----

async function scan(): Promise<void> {
  const range = readRange();
  if (!range) {
    showError(
      'Pick widths between 200 and 3840px, with the widest at least 16px wider than the narrowest.',
    );
    return;
  }
  saveSettings();
  showError(null);
  await endPreview();
  state.scanning = true;
  state.stopping = false;
  state.selected = null;
  ui.stale.hidden = true;
  renderToolbar('Starting…');
  const startedAt = new Date();
  try {
    await session.attach();
    const result = await scanTab(session, {
      analyzerScript: __ANALYZER_SCRIPT__,
      minWidth: range.min,
      maxWidth: range.max,
      reload: ui.reload.checked,
      onProgress: ({ width, measured }) => {
        renderToolbar(`Measuring ${width}px · ${measured} ${measured === 1 ? 'width' : 'widths'}`);
        showNow(width);
      },
      cancelled: () => state.stopping,
    });
    state.result = result;
    state.range = range;
    state.startedAt = startedAt;
    if (result.status !== 'scanned') showError(result.error ?? 'The page could not be scanned.');
  } catch (error) {
    if (!(error instanceof Cancelled)) {
      const message = error instanceof Error ? error.message : String(error);
      showError(
        /detached|target closed|No tab with given id/i.test(message)
          ? 'The scan stopped because the debugging bar was closed or the tab went away.'
          : `The scan failed: ${message}`,
      );
    }
  } finally {
    await session.detach();
    state.scanning = false;
    showNow(null);
    render();
  }
}

// ---- seeing a width in the page ----

async function preview(width: number, issue?: Issue): Promise<void> {
  if (state.scanning) return;
  showError(null);
  try {
    await session.attach();
    // Height 0 keeps the tab's own height, so the page can still be scrolled.
    await setWidth(session, width, 0);
    await evaluate(session, () => window.__breakhound?.settleAfterResize(1000));
    if (issue) {
      const found = await evaluate<boolean>(
        session,
        (o: { selector: string; related: string | null; edge: boolean }) => {
          const api = window.__breakhound;
          if (!api) return false;
          api.clearHighlights();
          const el = api.resolveSelector(o.selector);
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
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
        },
      );
      if (!found) {
        showError(
          "That element isn't on the page right now. It may only appear after something else happens.",
        );
      }
    } else {
      await evaluate(session, () => window.__breakhound?.clearHighlights());
    }
    state.previewWidth = width;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    await session.detach();
    state.previewWidth = null;
  }
  renderPreview();
}

async function endPreview(): Promise<void> {
  if (state.previewWidth === null && !session.isAttached) return;
  if (session.isAttached) {
    await evaluate(session, () => window.__breakhound?.clearHighlights()).catch(() => {});
    await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await session.detach();
  }
  state.previewWidth = null;
  renderPreview();
}

/** Selects the element in the Elements panel. */
function inspect(issue: Issue): void {
  chrome.devtools.inspectedWindow.eval(
    `inspect(window.__breakhound ? window.__breakhound.resolveSelector(${JSON.stringify(issue.element.selector)}) : document.querySelector(${JSON.stringify(issue.element.selector)}))`,
  );
}

// ---- rendering ----

function renderToolbar(status: string): void {
  ui.scan.disabled = state.scanning;
  ui.scan.textContent = state.result ? 'Scan again' : 'Scan this page';
  ui.stop.hidden = !state.scanning;
  ui.stop.disabled = state.stopping;
  ui.min.disabled = ui.max.disabled = ui.reload.disabled = state.scanning;
  ui.copyAll.hidden = state.scanning || !state.result?.issues.some((i) => i.severity !== 'info');
  ui.status.textContent = status;
}

function x(width: number): number {
  const { min, max } = state.range;
  return ((width - min) / (max - min)) * 100;
}

function showNow(width: number | null): void {
  ui.now.hidden = width === null || !state.result;
  if (width !== null) ui.now.style.left = `${x(width)}%`;
}

function renderPreview(): void {
  const width = state.previewWidth;
  ui.preview.hidden = width === null;
  ui.previewText.textContent = width === null ? '' : `Showing the page at ${width}px wide.`;
  showNow(width);
}

function renderTimeline(result: RouteResult): void {
  const { min, max } = state.range;
  const bp = result.breakpoints;
  ui.axis.replaceChildren();
  ui.lanes.replaceChildren();

  // Labels at the ends and at media query widths, skipping any that would collide.
  const labels: { width: number; cls: string }[] = [
    { width: min, cls: 'label start' },
    ...bp.declared.map((width) => ({ width, cls: 'label' })),
    { width: max, cls: 'label end' },
  ];
  let lastPct = Number.NEGATIVE_INFINITY;
  for (const { width, cls } of labels) {
    const pct = x(width);
    if (pct - lastPct < 6 && cls === 'label') continue;
    ui.axis.append(h('span', { class: cls, style: `left:${pct}%` }, `${width}`));
    lastPct = pct;
  }
  for (const width of bp.declared) {
    ui.axis.append(
      h('span', { class: 'tick', style: `left:${x(width)}%`, title: `Media query at ${width}px` }),
    );
  }
  const unexplained = new Set(bp.unexplained);
  for (const width of bp.observed) {
    const odd = unexplained.has(width);
    ui.axis.append(
      h('span', {
        class: odd ? 'mark unexplained' : 'mark',
        style: `left:${x(width)}%`,
        title: odd
          ? `The layout changes at ${width}px, with no media or container query there`
          : `The layout changes at ${width}px`,
      }),
    );
  }

  for (const issue of result.issues) {
    const lane = h('div', {
      class: `lane ${issue.severity}${issue.id === state.selected ? ' selected' : ''}`,
      title: `${issue.title} (${formatRanges(issue.ranges)})`,
    });
    for (const r of issue.ranges) {
      lane.append(
        h('span', {
          class: 'bar',
          style: `left:${x(r.from)}%;width:${x(r.to) - x(r.from)}%`,
        }),
      );
    }
    lane.addEventListener('click', (e) => {
      e.stopPropagation();
      select(issue.id);
    });
    ui.lanes.append(lane);
  }
}

function renderIssue(issue: Issue): HTMLLIElement {
  const open = issue.id === state.selected;
  const head = h(
    'button',
    { class: 'issue-head', type: 'button' },
    h('span', { class: 'dot' }),
    h('span', { class: 'issue-title' }, issue.title),
    h('span', { class: 'ranges' }, formatRanges(issue.ranges)),
  );
  head.setAttribute('aria-expanded', String(open));
  head.addEventListener('click', () => select(open ? null : issue.id));
  const li = h('li', { class: `issue ${issue.severity}${open ? ' open' : ''}` }, head);
  if (!open) return li;

  const evidence = evidenceText(issue);
  li.append(
    h(
      'div',
      { class: 'issue-body' },
      h(
        'p',
        { class: 'muted' },
        `${DETECTOR_LABELS[issue.detector]} · worst at ${issue.worstAt}px`,
        evidence ? ` · ${evidence}` : '',
      ),
      h('p', {}, 'Element: ', h('code', {}, issue.element.selector)),
      issue.related && h('p', {}, 'Together with: ', h('code', {}, issue.related.selector)),
      issue.element.text && h('p', { class: 'muted' }, `Text: “${issue.element.text}”`),
      issue.suggestion && h('p', {}, issue.suggestion),
      h(
        'div',
        { class: 'actions' },
        button(`Show at ${issue.worstAt}px`, () => void preview(issue.worstAt, issue)),
        ...issue.ranges
          .filter((r) => r.from !== issue.worstAt && r.to !== r.from)
          .slice(0, 2)
          .map((r) => button(`Show at ${r.from}px`, () => void preview(r.from, issue))),
        inDevtools && button('Select in Elements', () => inspect(issue)),
        button('Copy prompt', async (b) => {
          flash(b, (await copyText(prompt([issue.fingerprint]))) ? 'Copied' : 'Could not copy');
        }),
      ),
    ),
  );
  return li;
}

function select(id: string | null): void {
  state.selected = id;
  const issue = state.result?.issues.find((i) => i.id === id);
  render();
  if (issue) void preview(issue.worstAt, issue);
}

function render(): void {
  const result = state.result;
  const scanned = result?.status === 'scanned';
  ui.intro.hidden = scanned;
  ui.results.hidden = !scanned;
  if (!result || !scanned) {
    renderToolbar('');
    return;
  }
  const n = result.issues.length;
  const seconds = (result.durationMs / 1000).toFixed(1);
  renderToolbar(`${result.measurements} widths in ${seconds}s`);

  const changes = result.breakpoints.observed.length;
  const odd = result.breakpoints.unexplained.length;
  ui.summary.textContent = [
    n === 0
      ? `No issues between ${state.range.min}px and ${state.range.max}px.`
      : `${n} ${n === 1 ? 'issue' : 'issues'} between ${state.range.min}px and ${state.range.max}px.`,
    changes
      ? `The layout changes at ${changes} ${changes === 1 ? 'width' : 'widths'}${odd ? `, ${odd} with no media or container query` : ''}.`
      : 'The layout never changes.',
    ...result.warnings,
  ].join(' ');

  renderTimeline(result);
  ui.issues.replaceChildren(
    ...(n ? result.issues.map(renderIssue) : [h('li', { class: 'clean' }, 'Nothing breaks.')]),
  );
  renderPreview();
}

// ---- timeline pointer ----

function widthAt(clientX: number): number {
  const box = ui.timeline.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  const { min, max } = state.range;
  return Math.round(min + frac * (max - min));
}

ui.timeline.addEventListener('mousemove', (e) => {
  const width = widthAt(e.clientX);
  ui.cursor.hidden = false;
  ui.cursor.style.left = `${x(width)}%`;
  ui.cursor.classList.toggle('flip', x(width) > 85);
  (ui.cursor.firstElementChild as HTMLElement).textContent = `${width}px`;
});
ui.timeline.addEventListener('mouseleave', () => {
  ui.cursor.hidden = true;
});
ui.timeline.addEventListener('click', (e) => {
  void preview(widthAt(e.clientX));
});

// ---- wiring ----

ui.scan.addEventListener('click', () => void scan());
ui.stop.addEventListener('click', () => {
  state.stopping = true;
  renderToolbar('Stopping…');
});
ui.previewEnd.addEventListener('click', () => void endPreview());
ui.copyAll.addEventListener('click', async () => {
  flash(ui.copyAll, (await copyText(prompt())) ? 'Copied' : 'Could not copy');
});
for (const input of [ui.min, ui.max, ui.reload]) input.addEventListener('change', saveSettings);

session.onDetach = () => {
  // The developer closed the debugging bar, or the tab went away.
  state.stopping = state.scanning;
  state.previewWidth = null;
  renderPreview();
};

if (inDevtools) {
  chrome.devtools.network.onNavigated.addListener(() => {
    if (state.scanning) return;
    void endPreview();
    if (state.result) ui.stale.hidden = false;
  });
}

// Leave the tab as it was when DevTools closes.
addEventListener('pagehide', () => {
  if (session.isAttached) void session.detach();
});

loadSettings();
render();
