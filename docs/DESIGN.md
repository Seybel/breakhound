# breakhound design

> Sniffs out where your layout breaks, then hands the fix to your coding agent.

License: MIT

---

## 1. Problem

Checking responsiveness today is manual: open responsive mode, click through device presets or drag the viewport slowly, spot what broke, then describe each problem to an AI agent in prose ("at around 800px the nav wraps..."). It's slow, it misses widths between presets, and it has to be redone on every page after every change.

## 2. Goals

1. **Zero-config.** `npx @seybel/breakhound` in a project root works for React, Vue and any JS frontend: it finds the dev server, discovers every route and scans them all.
2. **Find the exact pixel.** Report issues as width ranges (`812–1023px`), not device names.
3. **Objective, low-noise detection.** Rules, not guesses. A false positive costs more trust than a missed issue.
4. **Reports people and agents can use.** Summary and detailed reports, Markdown / HTML / PDF / JSON, and a copy-paste prompt tuned for coding agents.
5. **Your agent does the fixing.** The developer's own coding agent edits the code through MCP; breakhound verifies the result and can undo it per page.
6. **Free to run.** No hosted service, no model, no account.

### Non-goals (v1)

- Judging aesthetics ("this looks cramped") as a rule. An opt-in vision model can add its opinion as info (6.6).
- Replacing visual-regression tools (Percy, Chromatic). We detect bugs; we don't diff approved screenshots.
- Deterministic automatic code edits. Framework and styling diversity makes that fragile; agents do the edits.

---

## 3. User experience

```bash
npx @seybel/breakhound                 # detect, discover, scan everything, write reports
npx @seybel/breakhound /pricing        # scan one route
npx @seybel/breakhound --url https://staging.example.com
npx @seybel/breakhound login           # open a browser, log in once, save the session locally
npx @seybel/breakhound report          # reopen the last report
npx @seybel/breakhound prompt          # print the agent prompt for the last scan (pipe to clipboard)
npx @seybel/breakhound mcp             # start the MCP server (normally launched by the agent)
npx @seybel/breakhound undo [routes…]  # revert breakhound fix commits
```

Example run:

```
✔ Detected Nuxt 3 · dev server running on :3000
✔ 16 routes found (3 dynamic → sampled from links on your pages)
⚠ /dashboard/* redirects to /login → run `breakhound login` once
◐ Scanning 16 routes × 320–1920px…

  /                ✔ clean · 3 layout breakpoints (640, 768, 1024)
  /pricing         ✖ 2 issues
     812–1023px    nav wraps onto 2 lines                     header nav
     320–359px     page scrolls horizontally (+38px)          .pricing-table
  /blog/[slug]     ⚠ 1 warning
     320–413px     tap target 32×32px                          .share-btn

  3 issues across 2 routes · report: .breakhound/report/index.html
  Fix with your agent:  npx @seybel/breakhound prompt | pbcopy
```

Exit code is non-zero when issues at or above `--fail-on` severity exist (1), or when a page could not be checked at all (2), so the same command works in CI.

---

## 4. Architecture

TypeScript monorepo (npm workspaces). Users install one package, `@seybel/breakhound` (its command is `breakhound`); the rest are internal packages bundled into it (published separately only if there's demand).

```
packages/
  analyzers/   Pure DOM functions: detectors + layout fingerprint. No Node APIs.
               Runs in any page context (Playwright, and the DevTools panel).
  engine/      Playwright orchestration: launch, settle, sweep + bisect,
               run analyzers, dedupe issues across widths, capture screenshots.
  routes/      Project detection (framework, package manager, dev server)
               + route discovery adapters.
  report/      Issue JSON → summary MD, detailed HTML, PDF, agent prompt.
  source/      Dev-only build plugins (Vite, Next, webpack) marking elements
               with data-bh-src="file:line:column".
  cli/         `breakhound` command. Wires everything together, and holds the
               MCP server, verify, and git checkpoints/undo.
  extension/   Chrome DevTools panel: the engine's sweep run on the inspected
               tab over the DevTools Protocol.
fixtures/      Synthetic pages with known, labelled responsive bugs (test corpus).
docs/
```

Data flow:

```
routes ──► engine ──(injects)──► analyzers (in page)
              │                        │
              ◄──── raw findings ──────┘
              │
              ▼
        Scan result JSON  ──►  report (MD / HTML / PDF / prompt)
              │
              └──►  mcp (agent reads issues, edits code, calls verify)
```

**Key decision:** detection logic lives only in `analyzers` and has no dependency on Playwright. That's what lets the CLI, MCP server, CI and the DevTools panel all share one engine.

### Tech choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Contributors, types for the JSON schema |
| Package manager | npm workspaces | Ships with Node, no extra setup for contributors |
| Browser automation | Playwright (Chromium default; `--browsers webkit,firefox` optional) | Exact viewports, headless, parallel, cross-engine |
| Build | tsup | Simple bundling for CLI + injected analyzer script |
| Tests | Vitest + Playwright against `fixtures/` | Fast unit tests, real layout in integration tests |
| Lint/format | Biome | One fast tool |
| CLI framework | Node's built-in `util.parseArgs` and `util.styleText` | Zero dependencies |
| MCP | Own stdio server (JSON-RPC lines), tested with `@modelcontextprotocol/sdk`'s client | Works with Claude Code, Cursor, Copilot, Codex, Windsurf; the SDK would add ~15 runtime packages (Express, Hono...) to every `npx @seybel/breakhound` |
| Node | ≥ 20 | Current LTS range |

Browser download: `breakhound` uses Playwright's Chromium. On first run, if no browser is installed, we run the install automatically with a clear message (about 150 MB, one time).

---

## 5. Route discovery

Local development means we have the source, so routes come from the source or the live router, not from crawling.

### 5.1 Project detection

1. Read `package.json` → framework (next, nuxt, vite + react-router / vue-router, @sveltejs/kit, astro, @remix-run / react-router v7, @tanstack/react-router, @angular/router).
2. Package manager from the lockfile.
3. Dev server: probe the port the framework's config specifies, then common ports (3000, 5173, 4321, 8080, 4200…), matching the response to the project. If nothing is running, start the `dev` script, wait for readiness, and stop it when done.

### 5.2 Adapters (in priority order)

| Adapter | Source | Notes |
|---|---|---|
| Next.js App Router | `app/**/page.{tsx,jsx,js,mdx}` | Strip `(groups)`, skip `@slots` and `(.)intercepts`, handle `[id]`, `[...slug]`, `[[...slug]]` |
| Next.js Pages Router | `pages/**` | Skip `_app`, `_document`, `api/` |
| Nuxt 2/3/4 | `pages/**/*.vue`; runtime `useRouter().getRoutes()` for custom routes | Handles `[id]`, `[...slug]` |
| SvelteKit | `src/routes/**/+page.svelte` | |
| Astro | `src/pages/**` | |
| Remix / React Router v7 framework | `app/routes/**` or runtime manifest | |
| TanStack Router | generated `routeTree.gen.ts` | |
| Vue Router (code-defined) | **Runtime**: `app.$router.getRoutes()` from the mounted Vue app | Same source Vue DevTools uses |
| React Router (code-defined) | **Runtime**: data-router instance if present; otherwise walk the React fiber tree for `<Route path>`. **Static fallback**: parse route files with an AST (`createBrowserRouter([...])`, `<Route path>`) | Hardest case |
| Angular | Route objects in code, followed from `src/main.ts`; a `loadChildren` file's routes sit under that route's path; `**` and `redirectTo` are left out | |
| Fallback | Same-origin link crawl from `/` (bounded depth and count) | For unknown setups only |

Routes read from the live router come first where the framework has one (Nuxt, Vue, React Router, Remix, TanStack), because plugins and modules add routes that files don't show. React apps can declare more routes inside pages (`<Routes>` nested in a component), so the router is read again on every page scanned. The React fiber tree is read from the root's current tree (`stateNode.current`), since the container keeps the fiber from the first render.

When nothing lists the routes, links are followed from `/`: every top-level page, at most three siblings deeper down, 50 pages in total. Links that log out, delete, unsubscribe, point at `/api/` or at files are never followed.

### 5.3 Dynamic routes

For each dynamic pattern (`/products/[id]`), look for a real matching link on already-scanned pages (e.g. `/products/42`); the most specific pattern wins, so `/blog/new` is not taken as a sample of `/blog/[slug]`. `samples` in the config sets one explicitly. Once the links have run out, a route still waiting is built from known values: a parent route's real URL gives its parameters to the routes below it (`/users/jane` fills `[username]` in `/users/[username]/settings`, but `/products/7` never fills `/orders/[id]`), and `params` in the config gives values by name for any route. A sample is used as given, a real link is used when there's no sample, and built values only fill what's left. If something is still missing, the route is reported as skipped, naming the parameters to add to `params`. The CLI doesn't prompt, so the same command behaves the same in a terminal and in CI. Only one sample per pattern, since instances share a layout.

### 5.4 Auth

If a route redirects to a login-like page (a sign-in path, another origin, or a page with a visible password field), or answers 401/403, it's reported with status `login` and not scanned. A redirect to a page that is scanned anyway is reported as `redirect`. Neither fails the run; only pages that errored or rendered nothing exit with 2. `breakhound login` opens a headed browser; the developer logs in themselves; the session (Playwright `storageState`) is saved to `.breakhound/auth.json` (mode 600), in a folder that keeps itself out of git (see §9). breakhound never sees or stores passwords.

### 5.4.1 Dev server

A running server is found by probing the ports from the dev script, the framework config and the framework default, then common ports, and only accepted if the HTML carries the framework's fingerprint (`/_next/`, `/_nuxt/`, the Vite entry script from `index.html`, ...), so another project left running isn't scanned by mistake. A project breakhound can't fingerprint only accepts a server on a port it sets itself (dev script, framework config, `server.port`), never on a guessed one, and never one serving another framework's markers. Otherwise the `dev` script is started in its own process group, its output is read for the local URL, and the whole group is stopped afterwards. `server.command` in the config replaces the script (for example a preview build in CI). Settling a page ignores requests open longer than 3s (long polling, realtime sync), which would otherwise hold every page for the full network timeout.

A dev server for a big app can take gigabytes (Turbopack's first compile especially), and on an 8 GB laptop a dev server plus a browser can push the machine into swap until it freezes. So while breakhound works, a guard samples once a second (every 5s on Windows) the memory of everything it runs (the footprint on macOS, which unlike resident size counts compressed memory; under pressure a 600 MB process can show 30 MB resident): its own process tree, plus the process group of each dev server it started, which catches children that outlived the shell. It also reads the system's own signal: macOS's memory pressure level (only `critical`; `warn` is normal on 8 GB Macs) and `MemAvailable` on Linux. Past `memoryLimit` (default 60% of RAM, leaving at least 2 GB), or with the system critical for 3 samples in a row while breakhound uses at least 1 GB, it SIGKILLs the dev server's group and the browser, and the scan fails with what used the memory and what to try. It never touches processes it didn't start. The dev server is registered the moment it spawns, so a runaway first compile is caught before the server even answers.

### 5.5 Config (optional)

`breakhound.config.ts`, created by `breakhound init`, never required:

```ts
export default {
  baseUrl: 'http://localhost:3000',
  include: ['/**'],
  exclude: ['/admin/**'],
  samples: { '/products/[id]': '/products/42' },
  maxRoutes: 100,
  server: { command: 'npm run preview', port: 4173 },
  widths: { min: 320, max: 1920 },
  ignore: [{ selector: '.marquee', detectors: ['page-overflow'] }],
  failOn: 'error',
};
```

---

## 6. Scanning

### 6.1 Settling a page

Before any measurement: wait for network idle and `document.fonts.ready`; inject CSS that disables animations/transitions and hides carets; pause videos; freeze `Date` optionally; auto-dismiss common cookie banners by hiding (never clicking "accept"); scroll through the page once to trigger lazy content, then back to top. After each resize: wait two animation frames plus a short debounce (default 150 ms) so JS resize handlers run.

### 6.2 Width sweep

- Default range **320–1920px**, `--wide` extends to 2560. Height is fixed at 900 (layout width is what matters; full-page measurement doesn't depend on height).
- **Coarse pass:** every 16px (≈100 widths). At each width, run all detectors and take a layout fingerprint.
- **Refine pass:** wherever the set of issues or the fingerprint changes between two coarse widths, binary-search to the exact pixel (≤4 extra layouts per change).
- One browser page per route, reused across widths (resizing is much cheaper than reloading). Routes run in parallel (default: CPU cores − 1).
- Target: a typical page in under 10 seconds; 20 routes in under a minute.

### 6.3 Layout fingerprint and behavioral breakpoints

At each width, record for "significant" elements (landmarks, direct children of `body`/`main`, large blocks, flex/grid containers): position relative to the viewport, width as a fraction of the viewport, row/column placement, and visibility. Between neighbouring widths, fluid layouts change smoothly; a **behavioral breakpoint** is where the fingerprint jumps (an element changes row, appears/disappears, or changes relative width sharply).

We also read declared breakpoints from `@media` / `@container` rules in `document.styleSheets` and report:

- `observed`: widths where the layout actually changes
- `declared`: widths the CSS declares
- `containers`: widths where a container query switches. At each width the analyzers note which `@container` width thresholds each size container is past, so the sweep bisects to the exact pixel where one flips.
- `unexplained`: observed changes with neither a media query nor a container query switching nearby (often a wrap or overflow bug)

### 6.4 Interaction states

Menus, drawers, modals and accordions are closed when a page loads, so the width sweep never sees them open. While sweeping, the analyzers also list what can be opened at each width:

- elements with `aria-expanded` (closed), `aria-haspopup`, `popovertarget`, `commandfor`, or Bootstrap's `data-bs-toggle`
- the summary of a closed `<details>`
- buttons that are plainly a menu by class, id or accessible name (`hamburger`, `navbar-toggler`, `menu-toggle`, "Menu", "☰")

Links to other pages, submit buttons, comboboxes, disabled controls and anything marked `data-breakhound-ignore="states"` are never pressed.

After the page's own sweep, up to `states` toggles (default 5) are opened one at a time, menus and dialogs in the header first, and one per group of look-alikes (one FAQ question stands for all). Each is swept only over the widths where the toggle shows, plus one width either side so bisection finds exactly where it appears. At every width the toggle is pressed again if a resize closed it. It's pressed with a real mouse click at its centre, after checking that nothing covers it there, since many components open on pointer down rather than click. Whether it's open comes from the page (`aria-expanded`, `details.open`, `:popover-open`, `dialog.open`), or, when the page doesn't say, from the biggest element that came on screen when it was first pressed. A toggle that opens nothing is dropped. One that loads another page is dropped too, and the tab is loaded again.

Findings that the closed page also has at that width are removed, so only what breaks while open is reported. Those issues carry `state` (`kind`, `label`, `trigger`). Their id and fingerprint include the trigger, their title ends with what was open (`with "Menu" open`), reports and prompts say what to click first, and screenshots are taken with it open. The tabs that measured the page are reused, and each is loaded again between states so nothing leaks from one to the next.

### 6.5 Other browsers

`browsers` (or `--browsers chromium,webkit,firefox`) adds engines. The first one does everything a scan does: it finds the routes, follows links and reads routers. The others then scan the pages it could scan, at the same URLs, one browser after another, so only one engine is ever running. Results are merged per page by issue id: the first browser's breakpoints and details are kept, every issue lists `browsers`, and one missing from some of them ends with "(only in WebKit)". Screenshots from extra browsers go in a folder named after the browser. Missing browsers are downloaded on first use, like Chromium, through Playwright's own CLI, found via `playwright/package.json` (its only stable export; newer versions don't export the CLI file).

The fixture corpus runs in every engine (`BREAKHOUND_TEST_BROWSER=webkit|firefox`, and in CI on one Node version). A marker can say an engine doesn't have the bug, `page-overflow!firefox`, because they really do differ: WebKit's form controls default to 11px (so unstyled controls are tiny text there only, and the likely fix says `font: inherit`), and Firefox breaks URLs after slashes, so a long URL that overflows in Chromium and WebKit wraps in Firefox. All three engines are at 100% precision and recall on the corpus.

### 6.6 Vision model (opt-in)

`--vision` (or `vision: true`) shows each scanned page at 375, 768 and 1280px (JPEG, the top 1800px) to the developer's own vision model, picked the same way as for `breakhound fix`. It asks for clear problems only, as JSON: width, title, a few words of visible text near the problem, and a likely fix. Each becomes a `vision` issue at that width, with severity `info`, tied to the smallest element showing that text (or the page), and screenshotted like any other. A model's opinion isn't a measurement: it never fails a run, it isn't run on verify, and verify ignores the baseline's vision issues.

### 6.7 DevTools panel

The extension (Manifest V3; permissions `debugger`, `contextMenus` and `sidePanel`) adds a breakhound panel to DevTools, and the same page in Chrome's side panel: "Scan with breakhound" on the page's right-click menu opens it there for that tab with `?scan`, so it starts scanning at once, and the toolbar icon opens it ready. Extensions can't open DevTools, which is why the quick way in is the side panel. Both calls (`sidePanel.setOptions` with the tab's path, then `sidePanel.open`) go out inside the click's user gesture, which Chrome requires. The menu only shows on http(s) and file pages, where the debugger can attach. The panel attaches `chrome.debugger` to the inspected tab and runs the engine's own `Sweeper`, `buildIssues`, `confirmNarrowIssues` and `buildBreakpoints`, imported from `@breakhound/engine/core`, which has no Playwright and no Node in it. A small adapter gives the sweep what it needs from a page: setting a viewport is `Emulation.setDeviceMetricsOverride` (with the screen size matching, as Playwright does), and evaluating is `Runtime.evaluate`. Issue ids hash with a bundled SHA-1 in place of `node:crypto`, so the panel and the CLI give an issue the same id, and the prompt it copies is `renderPrompt` from the report package.

The width fields have quick picks, Mobile 320–599, Tablet 600–1023 and Desktop 1024–1920, chosen to meet with no gap (600 is where most design systems move from phone to tablet, 1024 a tablet turned sideways and the usual desktop breakpoint). Picks combine only as a run of neighbours, since a sweep covers one range, so Mobile with Desktop is every width. They are shortcuts for the two fields and nothing more: a pick is shown as chosen whenever the fields match it, and typed widths match none.

Someone is watching the tab, so the sweep runs in `ascending` order: each change is bisected as soon as the coarse pass crosses it, and the page only ever grows, at most one coarse step back, instead of jumping across the range. It measures the same widths as the breadth-first order the CLI uses, and the parity tests hold it to the same results. Widths wider than the tab get the emulation's `scale` to fit (layout is unchanged, only the picture shrinks), and the panel draws the layout bands live from each measurement as it arrives. After the scan the timeline can be dragged to resize the tab: requests replace each other while one is in flight, so dragging never queues behind the page, and the issue in focus is outlined once the page settles.

The emulation always passes `dontSetVisibleSize`, as DevTools' device mode does: without it Chrome grows the tab's view to the emulated size, and a view wider or taller than the tab paints over DevTools beside it. When a width fits, the height is left unset so the page keeps filling the tab as DevTools is dragged; zoomed out, the height is the tab's divided by the scale. When the panel itself is resized (DevTools or the side panel being dragged resizes the tab next to it), the tab is measured again, with the emulation off for that moment, and the width reapplied. Outlines and the freeze style are removed through the debugger, which is gone once the developer cancels Chrome's debugging bar, so the page also cleans up after itself: while attached the panel checks in every second, and a small guard in the page removes them after two missed check-ins in a row (a busy page delays both, so it isn't mistaken for one left alone). In DevTools they are removed at once through `inspectedWindow.eval`, which needs no debugger.

It scans the page as it is: the analyzers are injected, animations frozen and reduced motion set for the scan, and afterwards the emulation, styles and scroll position are put back and the debugger detached. Since the page's resize handlers were set up before the probe could see them, "Reload first" adds the resize probe and analyzers as scripts for new documents and reloads, which makes it measure exactly like the CLI. Interaction states, other browsers and screenshots stay in the CLI. Chrome shows its "started debugging this browser" bar while attached, so the panel attaches only while it scans or shows a width.

"Whole site" scans the site the tab is on with the CLI's own planner (`RouteQueue`, `Crawler`, `routeFor`, the live router readers), which live in `@breakhound/routes/browser` with no Node in them: routes from the live router when there is one, dynamic ones filled in from links on scanned pages, otherwise links followed from this page and the home page, at most 25 pages. Pages load one at a time in the same tab with the resize probe and analyzers added for every new document, so each is measured as the CLI measures it, and the tab ends back on the page it started from. The developer's own session applies, so pages behind a login are scanned. A tab that is out of view draws no frames, so nothing settles: a slow answer from the page is checked against `document.visibilityState`, and while the tab is hidden measuring waits without a time limit (the panel says it's paused) instead of failing the page. Only time the page spends visible and silent counts toward giving up. Results are per page; the counts and the copied prompt go through `createScanResult`, so a shared component is one issue listed with its pages.

Tested two ways: the scan core against a Playwright CDP session, required to give the same issues and breakpoints as `Scanner.scanPage` on the same fixtures, and the built extension loaded into Chromium, driving the panel page against a fixture tab.

---

## 7. Detectors

Each detector is a pure function `(document, context) → Finding[]`. It must name the element it blames and why.

| ID | Detects | Method | Default severity |
|---|---|---|---|
| `page-overflow` | Page scrolls horizontally, or content is cut off at the screen edge | `scrollWidth > clientWidth` on the root; blame the outermost elements whose right edge passes the viewport and that aren't inside a scroll container. Fixed content (a modal) never scrolls, so past the edge it is reported as cut off | error |
| `content-overflow` | Content spilling out of its container | Child box exceeds a visibly bounded parent sideways, or past the bottom of a fixed-height one; parent `overflow` visible, not positioned or offset on purpose (negative margins, transforms, floats) | error |
| `overlap` | Elements unintentionally covering each other | Intersection of what actually paints in sibling branches of the page: text line piece by line piece (an inline element that wraps has a box spanning both lines, which would cross its neighbours), media and controls as boxes; ignores absolute/fixed overlays, badges, and `z-index` layers. The likely fix names the cause: content too big for its own box, a flex row out of room, or grid columns too narrow | error |
| `unexpected-wrap` | Rows/navs breaking onto extra lines | Children of a flex (`nowrap` or inline) container on different line boxes, where the container was single-line at wider widths | warning |
| `squished-text` | Text columns too narrow | Column narrower than 10em with more lines than words (words breaking apart), or under 3 characters per line. Chinese, Japanese, Korean and Thai wrap between any characters, so text mostly in those scripts only counts under 3 characters a line | warning |
| `distorted-media` | Stretched/squashed images and video | Rendered aspect ratio vs natural aspect ratio differs > 3% without `object-fit` | warning |
| `media-overflow` | Images wider than their container | Special case of content-overflow for `img`, `video`, `iframe`, `svg`, `canvas` | error |
| `small-tap-target` | Buttons/links too small on touch widths (< 768px) | WCAG 2.2 target size: box < 24×24 and a 24px circle around it touches another target. Inline text links and labelled checkboxes are exempt. Grouped per parent | warning |
| `tiny-text` | Unreadable text on small widths | Computed font size < 12px, grouped per parent | info |
| `oversized-text` | Headings too big for a phone | Below 768px, text of 28px or more on 3+ lines averaging under 12 characters a line (a word or two), with at least two words; narrow columns breaking words are left to `squished-text`. Quiet whenever the stacking could be on purpose: at least two of the lines must come from the size rather than `<br>` or preserved newlines, the text's block must fill its parent and at least 60% of the screen (so a `max-width: 8ch` heading or a card title in a two-column grid is left alone), and positioned, vertical and ornamental text is skipped. The likely fix is a `clamp()` up to the current size | warning |
| `edge-gutter` | Text pressed against a phone screen edge | The text's block container has < 4px between its content box and the screen edge (< 768px) | warning |
| `clipped-text` | Text cut off by a fixed-size container | Painted text box extends past a non-scrolling clip ancestor, or is pushed entirely below one that still shows other text; blamed on the container; skips ellipsis, line-clamp, sliders, collapsed panels and clips already present at the widest width | warning |
| `viewport-meta` | Missing/incorrect viewport tag | DOM check, once per page | error |
| `calendar` | A month or week calendar whose 7 days don't fit side by side | Not a check of its own: what the overflow, overlap and text checks find inside a calendar is reported once, as the calendar. A calendar is a row of the 7 weekday names in order, as shown (in the page's language or English, full, short, one letter, or with dates as in "Mon 12"; after a time or week number column too), over day cells lined up under them, however many wrappers away, that are at least 56px tall, so a date picker stays as it was. The likely fix is the calendar's, from the width where it starts to fit: let it scroll sideways inside its own box, or show the days as a list below that width. The project's settings for the checks it stands for still apply: switched off, they leave it out, and their severities set its own | the worst inside it |

Ornamental text (inside `aria-hidden="true"`, or under 30% opacity counting every ancestor) is something to look at, not read, so the text checks skip it, and `page-overflow` doesn't report it cut off by a wrapper. It still reports it when it makes the page scroll sideways, since that breaks the page whatever it is.


**False-positive controls** (built in, not optional):

- Skip content inside scroll containers (`overflow: auto/scroll`), carousels (`scroll-snap`, known carousel roles), `aria-hidden`, visually-hidden patterns (`sr-only`), off-screen drawers (`transform` off-viewport + `visibility`), and elements with zero opacity.
- An issue is reported only if it persists for at least 2 consecutive coarse widths (or is confirmed by bisection), filtering 1px rounding noise.
- The same element + detector across adjacent widths merges into one issue with a width range.
- User `ignore` rules in config and an HTML attribute escape hatch: `data-breakhound-ignore="overlap"`.

**Merging:** overflow reported by several detectors on the same element (page, media and content overflow) becomes one issue with joined ranges. When an overflowing element keeps the same width everywhere it overflows, the issue records `fixedWidthPx` and says so in the suggestion.

**Detection quality bar (the fixture corpus, in Chromium, WebKit and Firefox):**

- Every planted bug is found, at the widths it's marked with
- Nothing is reported on the pages of tricky-but-fine patterns
- Every finding is reproducible at the reported width

---

## 8. Issue schema (the contract)

All outputs are rendered from this JSON. It's versioned and published as a JSON Schema.

```ts
interface ScanResult {
  schemaVersion: 1;
  tool: { name: 'breakhound'; version: string };
  project: { framework: string | null; baseUrl: string; root: string | null };
  startedAt: string; durationMs: number;
  settings: { minWidth: number; maxWidth: number; step: number; browsers: string[] };
  routes: RouteResult[];
  summary: { routes: number; issues: number; uniqueIssues: number; bySeverity: Record<Severity, number> }; // bySeverity counts unique issues
}

interface RouteResult {
  route: string;            // pattern, e.g. /products/[id]
  url: string;              // concrete URL scanned
  status: 'scanned' | 'needs-login' | 'needs-sample' | 'error';
  breakpoints: { observed: number[]; declared: number[]; unexplained: number[] };
  issues: Issue[];
  states?: { kind: string; label: string; trigger: string; ranges: { from: number; to: number }[] }[];
}

type Severity = 'error' | 'warning' | 'info';

interface Issue {
  id: string;               // stable hash: route + detector + selector
  fingerprint: string;      // route-independent key, groups the same issue across pages
  detector: string;         // e.g. 'page-overflow'
  severity: Severity;
  title: string;            // "Nav wraps onto 2 lines"
  ranges: { from: number; to: number }[]; // inclusive width ranges where it occurs
  worstAt: number;          // width where it's most severe
  element: {
    selector: string;       // shortest unique selector
    path: string;           // readable path: header > nav > ul
    html: string;           // trimmed outerHTML snippet
    text: string | null;
    source: { file: string; line: number; column?: number } | null;
  };
  evidence: Record<string, unknown>;  // detector-specific numbers (e.g. overflowPx: 38)
  styles: Record<string, string>;     // relevant computed styles
  screenshot?: string;      // file in .breakhound/screenshots, element outlined, screen edge marked
  suggestion?: string;      // plain-language hint, e.g. "flex child needs min-width: 0"
  state?: { kind: 'menu' | 'dialog' | 'popover' | 'details' | 'disclosure'; label: string; trigger: string };
                            // only while this is open (6.4)
}
```

Issue `id` is stable across scans, which is what makes `verify` possible (fixed / still failing / new).

### Source locations

`source` is `{ file, line?, column?, component?, exact }`. `exact` means it's the element's own line; otherwise it's the file (and component) that renders it.

- **No setup:** read from the framework's dev info. React 18: the exact line (`_debugSource`). React 19: the owner component and, from its dev stack, its file. Vue 3: the component's `__file`. Paths are made relative to the project and kept only when the file exists.
- **One line (opt-in):** a build plugin (`breakhound/vite`, `breakhound/next`, `breakhound/webpack`) adds `data-bh-src="src/components/Nav.tsx:42:7"` to every HTML element in JSX/TSX, Vue templates and Svelte, on the dev server only. Library components aren't marked; for their elements the nearest marked ancestor (where the library component is used) is reported, with `exact: false`.
- **Neither:** the prompt still has the selector, classes and text for the agent to search with.

---

## 9. Reports

Written to `.breakhound/`, or `--out`. Whoever creates the folder (a scan, `login`, the fix session) also writes a `.gitignore` inside it containing `*`, as pytest and ruff do with their caches, so reports, screenshots and a saved login are never committed and the project's own `.gitignore` is never edited. It's only written when missing, so a developer who wants to commit reports can change it.

| Output | Content |
|---|---|
| `report/index.html` | **Detailed.** Self-contained file (images embedded or alongside). Per route: breakpoint timeline, each issue with element screenshot (highlighted), context screenshot, before/after at the breakpoint, selector, evidence, styles, suggestion. Filter by severity/route. Works offline. |
| `summary.md` | **Summary.** One line per issue grouped by route. |
| `report.md` | **Detailed Markdown** with image links. |
| `report.pdf` | Detailed report printed via Playwright (`--pdf`). |
| `result.json` | The raw `ScanResult`. |
| `prompt.md` | **Agent prompt.** See below. |

Screenshots: element crop with a red outline overlay plus a wider context crop, at `worstAt`. PNG, downscaled; capped per route to keep reports small.

### Agent prompt format

Tuned for agents, not people: short, structured, specific, one issue per block, with the acceptance test built in.

```md
Fix these responsive layout issues. Do not change behaviour at other widths.
After fixing, run `npx @seybel/breakhound verify` (or call the breakhound `verify` MCP tool)
and continue until it reports no remaining issues and no new ones.

## /pricing
1. [error] Page scrolls horizontally by 38px at 320–359px
   Element: `.pricing-table` (main > section.pricing > div.pricing-table)
   Source: src/components/PricingTable.vue:12
   Evidence: width 358px, min-width: 358px, viewport 320px
   Hint: fixed min-width exceeds small viewports
```

---

## 10. Fixing

| Way | How |
|---|---|
| Export | `breakhound prompt`, "Copy for agent" button in HTML report, `.md` / PDF export |
| MCP | Agent calls breakhound tools, edits code, verifies, repeats |
| Built-in fixer | `breakhound fix` with the developer's own API key or a local model (Ollama) |

### MCP tools

| Tool | Purpose |
|---|---|
| `list_routes` | Discovered routes and their status |
| `scan` | Scan routes (all or given); returns the summary |
| `list_issues` | Issues, filterable by route/severity |
| `get_issue` | Full detail for one issue incl. source location and screenshot |
| `verify` | Re-scan the given routes; returns **fixed / still failing / new (regressions)** compared with the baseline |
| `checkpoint` | Commit current changes for a route as a breakhound fix commit |
| `undo` | Revert breakhound fix commits for given routes |

Setup is one command: `npx @seybel/breakhound mcp install` detects Claude Code / Cursor / VS Code / Windsurf config and adds the server entry (showing the change and asking first). The server also offers a `fix` prompt (`/mcp__breakhound__fix` in Claude Code) that asks for the whole loop.

### From the browser extension

The panel's **Send to agent** hands a scan to the agent working on that app. Once the client has initialized, `breakhound mcp` also listens on the first free port of 47821–47830 on 127.0.0.1 (`BRIDGE_PORTS`). It answers only requests whose `Origin` is the breakhound extension (its id is pinned by a `key` in the manifest, and checked in tests against `EXTENSION_IDS`; `BREAKHOUND_EXTENSION_ID` lets a fork in) and whose `Host` is that address, so neither a web page nor a site rebinding its name to 127.0.0.1 gets through. A local process could fake both, but it could write the files itself anyway. It reads nothing from the project and returns nothing from it: it saves the scan it's sent (shape-checked, at most 32MB) into breakhound's folder, and hands out checks.

- **Which project.** The panel asks every port. Servers in the same project root count once: Claude Code and Cursor open on one app share its `.breakhound/`, so it goes to the project, not to an agent. Each is asked whether it serves the page (`servesProject`: on this machine, on a port the project uses, and serving what its dev server serves, the same check that decides whether the CLI can reuse a running dev server), or whether its config's `baseUrl` is that site. One match is sent to; otherwise the panel asks which project, and remembers the answer for that site.
- **Saving.** The scan becomes `result.json`, the reports and the baseline, with the project's config applied (checks turned off are dropped, severities overridden) and source files made relative, then the fix session starts as after a CLI scan. It is marked `from: "extension"`.
- **Verifying in the browser.** A headless rescan of a scan made in the developer's Chrome would differ for reasons that aren't the agent's: pages behind a login, scrollbars, extensions on the page. So `verify` on an extension baseline asks the panel to scan the pages again: the panel long-polls `checks` with its tab's origin, takes a check meant for that site, scans the pages in the tab (reloaded, at the baseline's widths, progress passed on to the agent) and posts them back; the comparison and reports are the CLI's own. If no panel takes the check within 20 seconds, verify says so and the agent asks the developer to open it. `scan` replaces an extension baseline with a headless one, after which verify is headless again; the instructions tell agents to call `list_issues` first so they don't do that by accident.
- **Store builds.** The manifest carries the Web Store's public key, so an unpacked build has the store's id and the same bridge accepts both. The store signs uploads itself and refuses a key in the manifest, so `npm run build:extension:store` leaves it out.

### Built-in fixer

`breakhound fix [routes]` is for people without a coding agent. The model is the developer's own: an Anthropic key, any OpenAI-compatible API (`OPENAI_BASE_URL`), or a local Ollama. It's picked from the environment in that order unless `--provider` or `fix.provider` says otherwise. breakhound has no key, service or model of its own.

For each unique issue in the baseline (errors and warnings, at most 20 by default):

1. Pick up to 4 files: the element's source file when known, then tracked files that mention its classes, id or text the most. Big files are cut down to the lines around those mentions. Files with uncommitted changes are left out.
2. Ask for edits as exact search and replace blocks, limited to those files.
3. Apply them all or none (a search must match exactly one place, ignoring trailing spaces), then `verify` the issue's routes against the dev server, which stays up for the whole run.
4. If the issue is gone and nothing new appeared, checkpoint the edited files as that route's fix commit. Otherwise write the files back and try once more, telling the model what happened (still there at which widths, or what broke where).

An API error stops the run, since it would fail every issue the same way.

### Verify loop

`verify` compares against the baseline scan: issue IDs that disappeared are **fixed**, IDs still present are **failing**, and new IDs (at any width, on any scanned route) are **regressions**. This is breakhound's main value in the fix loop: agents often fix 812px and break 1280px.

- The baseline is the last scan (`.breakhound/baseline.json`). A scan of some routes only replaces those routes in it. Verify never changes it, so every verify compares with the state before any fixes.
- Verify re-scans the baseline's pages at their URLs (moved to wherever the dev server runs now) with the baseline's width settings. With no routes it checks every page that was scanned.
- When a fix changes an element's classes, its selector and so its ID change. The same check on the same source line, or on an element with the same tag and text, still counts as the same issue rather than a fix plus a regression.
- The merged result is written as the current report, so `breakhound prompt` after a verify lists what's left.

### Undo (git-based)

- Fixing requires a git repo. A scan starts a session (`.breakhound/session.json`): the starting commit, and the files that already had changes.
- Each route's fix is one commit with a trailer: `Breakhound-Route: /pricing` and `Breakhound-Session: <id>`.
- `breakhound undo /pricing /blog` reverts those commits in one new commit (`Breakhound-Undo: <hash>`); `breakhound undo --session` reverts the whole session. History is never rewritten.
- Uncommitted user changes are never touched. Files changed before a scan count as the user's: a checkpoint that would include them stops and says so. Agents pass `files` (the files they edited) so a fix can be committed while the user has unrelated work in progress. Undo refuses to run over uncommitted changes.
- When `git revert` conflicts because a later fix changed a neighbouring line (common in one CSS file), undo reverses exactly the lines the fix changed, only if they're still as the fix left them. Otherwise nothing changes and it says why.
- No custom undo store, no file copies. Git is the source of truth.

---

## 11. Testing strategy

- **Unit tests** (Vitest + jsdom where layout isn't needed): selector generation, issue merging, range bisection, schema, report rendering, route adapters against fixture file trees.
- **Layout tests** (Vitest + real Chromium, WebKit and Firefox): each fixture page declares its expected issues (`data-bh-expect="page-overflow@320-359"`); the test scans it and compares. This is the accuracy benchmark, run in CI on every PR, with precision/recall reported.
- **Route discovery**: file-based adapters (Next, Nuxt, SvelteKit, Astro, Remix, TanStack) and the code reader are tested against generated file trees. The live-router readers run against small React Router (JSX and data router) and Vue Router apps in `fixtures/apps/`, bundled as minified production builds. A made-up app with a `dev` script covers starting and stopping the server, following links, login walls, `breakhound login` and samples end to end.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| False positives erode trust | Conservative defaults, ignore rules, fixture benchmark in CI in three engines |
| Code-defined React routes can't be discovered reliably | Runtime + AST + crawl fallback chain; config as a last resort, with a clear message |
| Flaky measurements (animations, async content) | Settling step, persistence rule, re-measure on disagreement |
| Slow scans on big apps | Resize-not-reload, coarse-then-bisect, parallel routes |
| Agents make bad fixes | Verify loop with regression detection; per-route undo |
| A big app's dev server plus the browser freezes the developer's machine | Memory guard on everything breakhound starts, with system pressure as a second signal; shuts down cleanly with advice (5.4.1) |
| Playwright browser download size | One-time install with clear messaging; reuse any installed Chromium |
