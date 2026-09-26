# breakhound — Design

> Sniffs out where your layout breaks, then hands the fix to your coding agent.

Status: **Approved** · License: MIT

---

## 1. Problem

Checking responsiveness today is manual: open responsive mode, click through device presets or drag the viewport slowly, spot what broke, then describe each problem to an AI agent in prose ("at around 800px the nav wraps..."). It's slow, it misses widths between presets, and it has to be redone on every page after every change.

## 2. Goals

1. **Zero-config.** `npx breakhound` in a project root works for React, Vue and any JS frontend: it finds the dev server, discovers every route and scans them all.
2. **Find the exact pixel.** Report issues as width ranges (`812–1023px`), not device names.
3. **Objective, low-noise detection.** Rules, not guesses. A false positive costs more trust than a missed issue.
4. **Reports people and agents can use.** Summary and detailed reports, Markdown / HTML / PDF / JSON, and a copy-paste prompt tuned for coding agents.
5. **$0 fixing.** The developer's own agent does the fixing through MCP; breakhound verifies the result and can undo it per page.
6. **Free to run.** No hosted service, no model, no account.

### Non-goals (v1)

- Judging aesthetics ("this looks cramped"). Possible later via optional bring-your-own vision model.
- Replacing visual-regression tools (Percy, Chromatic). We detect bugs; we don't diff approved screenshots.
- Deterministic automatic code edits. Framework and styling diversity makes that fragile; agents do the edits.

---

## 3. User experience

```bash
npx breakhound                 # detect, discover, scan everything, write reports
npx breakhound /pricing        # scan one route
npx breakhound --url https://staging.example.com
npx breakhound login           # open a browser, log in once, save the session locally
npx breakhound report          # reopen the last report
npx breakhound prompt          # print the agent prompt for the last scan (pipe to clipboard)
npx breakhound mcp             # start the MCP server (normally launched by the agent)
npx breakhound undo [routes…]  # revert breakhound fix commits
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
  Fix with your agent:  npx breakhound prompt | pbcopy
```

Exit code is non-zero when issues at or above `--fail-on` severity exist, so the same command works in CI.

---

## 4. Architecture

TypeScript monorepo (npm workspaces). Users install one package, `breakhound`; the rest are internal packages bundled into it (published separately only if there's demand).

```
packages/
  analyzers/   Pure DOM functions: detectors + layout fingerprint. No Node APIs.
               Runs in any page context (Playwright today, DevTools panel later).
  engine/      Playwright orchestration: launch, settle, sweep + bisect,
               run analyzers, dedupe issues across widths, capture screenshots.
  routes/      Project detection (framework, package manager, dev server)
               + route discovery adapters.
  report/      Issue JSON → summary MD, detailed HTML, PDF, agent prompt.
  mcp/         MCP server exposing scan / verify / checkpoint / undo tools.
  cli/         `breakhound` command. Wires everything together.
  extension/   (Phase 5) Chrome DevTools panel reusing analyzers.
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

**Key decision:** detection logic lives only in `analyzers` and has no dependency on Playwright. That's what lets the CLI, MCP server, CI and a future DevTools panel all share one engine.

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
| MCP | `@modelcontextprotocol/sdk` (stdio) | Works with Claude Code, Cursor, Copilot, Codex, Windsurf |
| Releases | Changesets + GitHub Actions | Versioning and changelogs |
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
| Angular | Runtime `Router.config` | Phase 4 |
| Fallback | Same-origin link crawl from `/` (bounded depth and count) | For unknown setups only |

### 5.3 Dynamic routes

For each dynamic pattern (`/products/[id]`), look for a real matching link on already-rendered pages (e.g. `/products/42`). If none is found, the route is marked "needs a sample" and the CLI asks once, saving the answer to config. Only one sample per pattern by default, since instances share a layout.

### 5.4 Auth

If a route redirects to a login-like page, it's reported as "requires login". `breakhound login` opens a headed browser; the developer logs in themselves; the session (Playwright `storageState`) is saved to `.breakhound/auth.json`, which the setup step adds to `.gitignore`. breakhound never sees or stores passwords.

### 5.5 Config (optional)

`breakhound.config.ts`, created on first run, never required:

```ts
export default {
  baseUrl: 'http://localhost:3000',
  include: ['/**'],
  exclude: ['/admin/**'],
  samples: { '/products/[id]': '/products/42' },
  widths: { min: 320, max: 1920 },
  ignore: [{ selector: '.marquee', rules: ['page-overflow'] }],
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
- `unexplained`: observed changes with no nearby declared breakpoint (often a wrap or overflow bug)

---

## 7. Detectors

Each detector is a pure function `(document, context) → Finding[]`. It must name the element it blames and why.

| ID | Detects | Method | Default severity |
|---|---|---|---|
| `page-overflow` | Page scrolls horizontally | `scrollWidth > clientWidth` on the root; blame the outermost elements whose right edge passes the viewport and that aren't inside a scroll container | error |
| `content-overflow` | Content spilling out of its container | Child box exceeds parent box where parent `overflow` is visible, not a scroll container, not positioned intentionally | error |
| `clipped-text` | Text cut off | `overflow: hidden` + `scrollWidth > clientWidth` on text, without `text-overflow: ellipsis` or line-clamp | warning |
| `overlap` | Elements unintentionally covering each other | Box intersection between in-flow siblings, confirmed by `elementFromPoint` sampling; ignores absolute/fixed overlays, badges, and `z-index` layers | error |
| `unexpected-wrap` | Rows/navs breaking onto extra lines | Children of a flex (`nowrap` or inline) container on different line boxes, where the container was single-line at wider widths | warning |
| `squished-text` | Text columns too narrow | Container narrower than ~6 characters of its font size, or words breaking mid-word | warning |
| `distorted-media` | Stretched/squashed images and video | Rendered aspect ratio vs natural aspect ratio differs > 3% without `object-fit` | warning |
| `media-overflow` | Images wider than their container | Special case of content-overflow for `img`, `video`, `iframe`, `svg`, `canvas` | error |
| `small-tap-target` | Buttons/links too small on touch widths (< 768px) | Interactive element box < 24×24 (error) or < 44×44 (info) | warning |
| `tiny-text` | Unreadable text on small widths | Computed font size < 12px | info |
| `viewport-meta` | Missing/incorrect viewport tag | DOM check, once per page | error |
| `fixed-width` | Hard-coded widths wider than the viewport | Computed width in px > viewport, with a matching fixed `width`/`min-width` | error |

**False-positive controls** (built in, not optional):

- Skip content inside scroll containers (`overflow: auto/scroll`), carousels (`scroll-snap`, known carousel roles), `aria-hidden`, visually-hidden patterns (`sr-only`), off-screen drawers (`transform` off-viewport + `visibility`), and elements with zero opacity.
- An issue is reported only if it persists for at least 2 consecutive coarse widths (or is confirmed by bisection), filtering 1px rounding noise.
- The same element + detector across adjacent widths merges into one issue with a width range.
- User `ignore` rules in config and an HTML attribute escape hatch: `data-breakhound-ignore="overlap"`.

**Detection quality bar (measured against the fixture corpus and Projects A/B/C):**

- Precision ≥ 90% (at most 1 in 10 reported issues is not a real problem)
- Recall ≥ 80% on labelled fixture bugs
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
  summary: { routes: number; issues: number; bySeverity: Record<Severity, number> };
}

interface RouteResult {
  route: string;            // pattern, e.g. /products/[id]
  url: string;              // concrete URL scanned
  status: 'scanned' | 'needs-login' | 'needs-sample' | 'error';
  breakpoints: { observed: number[]; declared: number[]; unexplained: number[] };
  issues: Issue[];
}

type Severity = 'error' | 'warning' | 'info';

interface Issue {
  id: string;               // stable hash: route + detector + selector
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
  screenshots?: { element: string; context: string; before?: string };
  suggestion?: string;      // plain-language hint, e.g. "flex child needs min-width: 0"
}
```

Issue `id` is stable across scans, which is what makes `verify` possible (fixed / still failing / new).

### Source locations

- **Default (no setup):** we don't know the file. The agent prompt includes selector, classes and text so the agent can search for it.
- **Better (opt-in, one line):** a build plugin (`breakhound/vite`, `breakhound/next`, `breakhound/webpack`) that adds `data-bh-src="src/components/Nav.tsx:42"` in development only. `breakhound init` can add it.
- **Runtime hints where available:** Vue 3 exposes `__file` on component definitions in dev mode; React 19 owner stacks. Used when present, without setup.

---

## 9. Reports

Written to `.breakhound/` (gitignored by default):

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
After fixing, run `npx breakhound verify` (or call the breakhound `verify` MCP tool)
and continue until it reports no remaining issues and no new ones.

## /pricing
1. [error] Page scrolls horizontally by 38px at 320–359px
   Element: `.pricing-table` (main > section.pricing > div.pricing-table)
   Source: src/components/PricingTable.vue:12
   Evidence: width 358px, min-width: 358px, viewport 320px
   Hint: fixed min-width exceeds small viewports
```

---

## 10. Fixing (all $0 to the project)

| Tier | How | Phase |
|---|---|---|
| 1. Export | `breakhound prompt`, "Copy for agent" button in HTML report, `.md` / PDF export | 1 |
| 2. MCP | Agent calls breakhound tools, edits code, verifies, repeats | 3 |
| 3. Built-in fixer | `breakhound fix` with bring-your-own API key or local model (Ollama) | 4 |

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

Setup is one command: `npx breakhound mcp install` detects Claude Code / Cursor / VS Code / Windsurf config and adds the server entry (showing the change and asking first).

### Verify loop

`verify` compares against the baseline scan: issue IDs that disappeared are **fixed**, IDs still present are **failing**, and new IDs — at any width, on any scanned route — are **regressions**. This is breakhound's main value in the fix loop: agents often fix 812px and break 1280px.

### Undo (git-based)

- Fixing requires a git repo. Before the first change, breakhound records the starting commit.
- Each route's fix is one commit with a trailer: `Breakhound-Route: /pricing` and `Breakhound-Session: <id>`.
- `breakhound undo /pricing /blog` reverts those commits; `breakhound undo --session` reverts the whole session.
- Uncommitted user changes are never touched: if the working tree is dirty with non-breakhound changes, fixing stops and asks.
- No custom undo store, no file copies. Git is the source of truth.

---

## 11. Phases (to v1.0 launch)

We build in phases but don't stop until v1.0 is launched.

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 · Foundation + spike** | Monorepo, CI, fixture corpus (~30 labelled bugs), analyzers for `page-overflow`, `content-overflow`, `overlap`, `unexpected-wrap`, `media-overflow`; sweep + bisect on one URL; JSON output | Meets the precision/recall bar on fixtures; manual review of Projects A/B/C shows ≥ 90% precision. **If not, revise detectors before continuing.** |
| **1 · CLI + reports (MVP)** | All §7 detectors, fingerprint + breakpoints, settling, screenshots, HTML/MD/PDF/JSON/prompt reports, config file, `--fail-on` exit codes | One-command scan of a single URL produces all reports; used on A/B/C |
| **2 · Whole-app** | Project detection, dev-server detection/start, all §5 adapters, dynamic samples, `login`, parallel routes, CI mode + GitHub Action | `npx breakhound` with zero config discovers and scans every route of A, B and C |
| **3 · Agent loop** | MCP server, `mcp install`, `verify`, checkpoint/undo, source-location plugins (Vite, Next, webpack) | An agent fixes fixture bugs end-to-end with verify + per-route undo |
| **4 · Depth** | Interaction states (open menus/drawers/modals via `aria-expanded`, `<details>`, dialogs), WebKit/Firefox, `@container` awareness, `breakhound fix` (BYO key / Ollama), optional vision checks | Hamburger menus and modals are scanned open and closed |
| **5 · DevTools panel** | Chrome DevTools panel reusing `analyzers` for live single-page use | Panel shows issues and breakpoint timeline for the inspected tab |
| **6 · Launch (v1.0)** | Docs site, README with demo GIF, examples repo, contribution guide, issue templates, npm publish, Chrome Web Store listing, launch posts | Public release |

---

## 12. Testing strategy

- **Unit tests** (Vitest + jsdom where layout isn't needed): selector generation, issue merging, range bisection, schema, report rendering, route adapters against fixture file trees.
- **Layout tests** (Vitest + real Chromium): each fixture page declares its expected issues (`data-expect="page-overflow@320-359"`); the test scans it and compares. This is the accuracy benchmark, run in CI on every PR, with precision/recall reported.
- **Framework fixtures**: minimal Next, Nuxt, Vite+React Router, Vite+Vue Router, SvelteKit and Astro apps in `fixtures/apps/` to test detection and route discovery end-to-end.
- **Real-world checks**: Projects A/B/C, run locally only; results stay out of the repo.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| False positives erode trust | Precision gate in Phase 0, conservative defaults, ignore rules, fixture benchmark in CI |
| Code-defined React routes can't be discovered reliably | Runtime + AST + crawl fallback chain; config as a last resort, with a clear message |
| Flaky measurements (animations, async content) | Settling step, persistence rule, re-measure on disagreement |
| Slow scans on big apps | Resize-not-reload, coarse-then-bisect, parallel routes, `--changed` (routes touched since last scan, Phase 4) |
| Agents make bad fixes | Verify loop with regression detection; per-route undo |
| Playwright browser download size | One-time install with clear messaging; reuse any installed Chromium |

---

## 14. Open items

- Whether to publish internal packages separately: decide at launch.
- Repo lives at `github.com/Seybel/breakhound`; the unscoped npm package `breakhound` is published from the `seybel` npm account. An org can be created later (GitHub redirects transferred repos).
