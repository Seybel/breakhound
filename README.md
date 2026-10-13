# breakhound

[![npm](https://img.shields.io/npm/v/@seybel/breakhound)](https://www.npmjs.com/package/@seybel/breakhound) [![CI](https://github.com/Seybel/breakhound/actions/workflows/ci.yml/badge.svg)](https://github.com/Seybel/breakhound/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Seybel/breakhound/blob/main/LICENSE)

Find where your layout breaks across every viewport width, then hand the fix to your coding agent.

![breakhound scanning a small site in Chrome: every page from 320 to 1920px, then each issue shown at the width where it is worst](https://raw.githubusercontent.com/Seybel/breakhound/main/docs/demo.gif)

Instead of dragging the browser or clicking through device presets, run one command in your project. breakhound finds your framework and dev server (and starts it if needed), discovers every route, sweeps each page from 320px to 1920px in a real browser, finds the exact pixel where things go wrong, and tells you why:

```
✔ Next.js running at http://localhost:3000
✔ 14 routes from src/app (2 dynamic, filled in from links on your pages)
breakhound 1.0.0 · 14 pages · 320–1920px

  ✖ /pricing        2 issues · layout changes at 768, 1024   4.1s
  ✔ /about          clean · layout changes at 640, 1024      3.2s
  ✖ /blog/[slug]    1 issue · layout changes at 768          3.8s  as /blog/hello-world
  ○ /dashboard      Needs a login: it redirected to /login
  ...

  3 issues on 2 pages

  ✖ error    320–599px      Page scrolls horizontally (280px wider than the viewport)
              div.pricing-table · /pricing
              → It stays 600px wide no matter the screen size. Replace the fixed width
                with max-width: 100% (or a fluid width) so it can shrink.
  ⚠ warning  768–919px      Row of 6 items wraps onto 2 lines
              header nav ul · /pricing, /blog/[slug]
              → Collapse this row into a menu below this width, tighten its spacing, or
                let it scroll sideways.

  ○ 1 page needs a login. Run npx @seybel/breakhound login once to sign in, then scan again.

  Report  .breakhound/report.html  (npx @seybel/breakhound report to open it)
  Fix it  npx @seybel/breakhound prompt --copy  then paste into your coding agent
      or  npx @seybel/breakhound mcp install  so your agent can scan, verify and undo by itself
```

## Quick start

In your project folder:

```bash
npx @seybel/breakhound
```

That's it: no config. To keep it in your project instead, `npm i -D @seybel/breakhound`; the command it installs is `breakhound`. (The unscoped `breakhound` on npm is a different tool.)

If your dev server is already running it's used, otherwise breakhound starts it with your `dev` script and stops it when done. Chromium is downloaded automatically the first time (about 150 MB).

Other ways to run it:

```bash
npx @seybel/breakhound /pricing /blog          # only these routes
npx @seybel/breakhound http://localhost:3000   # just this one page
npx @seybel/breakhound --url https://staging.example.com   # every route, on another server
```

## Finding routes

| Project | Where routes come from |
|---|---|
| Next.js (App and Pages Router) | `app/` and `pages/`, skipping route groups, parallel slots, private folders and API routes |
| Nuxt | the live Vue router, so module and custom routes count too (falls back to `pages/`) |
| SvelteKit | `src/routes` |
| Astro | `src/pages` |
| Remix, React Router 7 | the route manifest, `app/routes.ts` and `app/routes/` |
| TanStack Router | `routeTree.gen.ts` and the live router |
| React Router (code-defined) | the live route tree, including `<Routes>` nested inside pages; falls back to reading your router code |
| Vue Router (code-defined) | the live router; falls back to reading your router code |
| Angular | your route definitions, from `src/main.ts` on, with lazily loaded `loadChildren` routes under their path |
| Anything else | links followed from the home page (up to 50 pages, a few per section) |

**Dynamic routes** like `/blog/[slug]` are scanned once, using a real link found on your pages (routes that share a template share a layout). If no page links to one, it's listed with a hint, and you can give it a URL:

```ts
samples: { '/products/[id]': '/products/42' }
```

**Pages behind a login** are spotted (they redirect to a sign-in page) and listed instead of scanning the login page over and over. Sign in once:

```bash
npx @seybel/breakhound login
```

A browser window opens; log in as you normally would, then press Enter. The session is saved to `.breakhound/auth.json`, which is never committed (see below), and used by later scans. breakhound never sees your password.

Links that would log you out, delete something, or download a file are never followed.

## What it checks

| Check | Finds |
|---|---|
| `page-overflow` | Anything that makes the page scroll sideways, or gets cut off at the screen edge (including inside full-width wrappers) |
| `content-overflow` | Content spilling out of a card, panel or bordered box, sideways or out of the bottom of a fixed-height box |
| `media-overflow` | Images, video and embeds that don't shrink with their container |
| `overlap` | Content painted on top of other content |
| `unexpected-wrap` | Nav rows and button labels breaking onto extra lines |
| `clipped-text` | Text cut off, or pushed out of sight, by a fixed-size container at narrower widths |
| `squished-text` | Columns so narrow that words break apart |
| `distorted-media` | Images stretched or squashed out of proportion |
| `small-tap-target` | Buttons and links under 24×24px that crowd each other on touch screens (WCAG 2.2) |
| `tiny-text` | Text under 12px on phones |
| `oversized-text` | Headings and display text left at their desktop size on phones, wrapping a word or two a line |
| `edge-gutter` | Text pressed against the edge of a phone screen |
| `viewport-meta` | A missing responsive viewport tag |

Every issue comes with the exact width ranges where it happens, the element to blame, the numbers behind it, a screenshot, and a likely fix. breakhound also reports the widths where your layout actually changes and flags changes that no media or container query explains.

It's built to be quiet: carousels, off-canvas menus, badges, decorative shapes, ellipsis and line-clamp, and framework dev overlays are all understood and left alone. It also looks inside web components (open shadow roots) and handles right-to-left pages.

### Safari and Firefox

Chromium finds most layout bugs, but Safari and Firefox lay some things out differently (flex gaps, `dvh` units, form controls, font metrics). `--browsers chromium,webkit,firefox` checks the pages again in WebKit (Safari's engine) and Firefox once Chromium is done, one browser at a time so memory stays flat. An issue that shows up in only some of them says so: `(only in WebKit)`. Each extra browser is a one-time download of about 80 to 90 MB, done on first use or ahead of time with `npx @seybel/breakhound install webkit firefox`.

Two differences you'll meet early: Safari gives buttons, inputs and selects an 11px font unless you set one (Chrome and Firefox use about 13px), so unstyled controls show up as tiny text only in WebKit, with `font: inherit` as the fix; and Firefox breaks long URLs at their slashes, so a URL that pushes the page wide in Chrome and Safari can wrap fine in Firefox.

### Menus, dialogs and expandable sections

A lot of what breaks on a phone is hidden until you tap: the mobile menu, a sign-up modal, an FAQ answer. After scanning a page as it loads, breakhound opens what it finds there one at a time and sweeps the widths where each can be opened. That covers buttons with `aria-expanded`, `<details>`, popovers, dialogs, Bootstrap toggles, and buttons that are clearly a menu (`hamburger`, `menu-toggle`, an accessible name of "Menu"). Only what breaks while something is open gets reported, with what to open first:

```
✖ 320–399px  Page scrolls horizontally (80px wider than the viewport), with "Menu" open
```

It never clicks a link to another page or a button that submits a form, and it opens only one question of an FAQ, since they all share a layout. It opens up to 5 per page. Set `states` to change that, or `--no-states` (or `data-breakhound-ignore="states"` on an element) to leave them closed.

### A second opinion from a vision model (optional)

Rules can't tell when a layout is merely cramped or awkward. `--vision` shows each page at 375, 768 and 1280px to your own vision model (an Anthropic or OpenAI key, or a local Ollama model such as `qwen2.5vl`, set up the same way as `breakhound fix`) and adds what it says looks off. Those come in as info, tied to the element whose text the model quotes, and never fail a run. Verify leaves them out, since an opinion can't be measured again.

## Reports

Every run writes to `.breakhound/`:

| File | What it is |
|---|---|
| `report.html` | Self-contained report: width map, filters, screenshots, copy buttons. Open it with `breakhound report`. |
| `summary.md` | One line per issue |
| `report.md` | Every issue with evidence and screenshots |
| `prompt.md` | Instructions for a coding agent |
| `result.json` | The raw result |
| `report.pdf` | With `--pdf` |

The folder is for you, not your repo, so it keeps itself out of git: breakhound puts a `.gitignore` inside it that ignores everything there, the way tool caches like `.pytest_cache` do. Nothing to add to your own `.gitignore`, and breakhound never edits it. To commit a report anyway, edit or delete that inner `.gitignore`; breakhound only writes it when it's missing.

## In Chrome DevTools

The breakhound extension runs the same checks on the tab you have open, with nothing to install in your project. The quickest way in is to right-click the page and choose **Scan with breakhound**: the breakhound panel opens in Chrome's side panel and starts right away. Clicking the breakhound icon in the toolbar opens it ready to scan, and the same panel is a **breakhound** tab in DevTools. The page grows steadily from 320px to 1920px (or the widths you set) while the timeline fills in live: each run of widths that share a layout, every width where the layout changes, and where something breaks. Then you get:

- the issues, each with its exact width ranges, the element, the numbers and the likely fix
- the timeline: the layout bands, the media query widths, the changes no media or container query explains, and a bar for each issue across the widths it covers

To check only some screens, pick **Mobile** (320 to 599px), **Tablet** (600 to 1023px) or **Desktop** (1024 to 1920px) next to the widths. Pick a neighbour as well to check both, so Mobile and Tablet is 320 to 1023px; **All** goes back to every width. They only fill in the two width fields, so you can still type any range you like, and a smaller range scans faster.

Drag across the timeline to resize the page live, click anywhere on it to jump to a width, or use the arrow keys to nudge a pixel at a time. Widths wider than the tab are zoomed out to fit, like DevTools' device mode, so a 1920px layout is shown whole, and the page refits when you drag DevTools bigger or smaller. If you press Cancel on Chrome's debugging bar, the tab goes back to its own width and breakhound's outlines disappear. Click an issue to see the page at the width where it's worst, with the element outlined. **Select in Elements** jumps to the element, and **Copy prompt** gives your coding agent the same instructions `breakhound prompt` would. (Select in Elements is only in the DevTools tab, since only DevTools has an Elements panel.) It finds what the CLI finds on the same page, since both run the same code.

While it scans or shows a width, Chrome displays a bar saying breakhound started debugging this browser: that is how an extension resizes a tab. The bar goes away afterwards, and the tab goes back to its own width and scroll position. **Reload first** reloads the page before scanning, so breakhound can wait for the page's own resize handlers exactly, as the CLI does. Leave it off to scan the page as you have it.

Switch to **Whole site** to scan every page, not just this one. breakhound finds the pages the way the CLI does: from the app's live router when it has one (Vue, React Router, Nuxt, Remix, TanStack), otherwise by following links from this page and the home page (never a logout, delete or file link, and a few pages per section, since blog posts share a layout), up to 25 pages. It loads each one in this tab, scans it, and comes back to where you were. Chrome stops drawing a tab that's out of view, so if you switch away while it runs, the scan pauses and carries on by itself when you come back. Your own login applies, so pages behind it are scanned too. Each page gets a chip with its issue count; an issue shared by several pages is counted once, and **Copy prompt** lists it once with every page it's on. Showing an issue from another page takes the tab there first.

**Send to agent** hands the issues to the coding agent working on that app, so it can fix them and check each fix in your browser. See [From the browser](#from-the-browser) below.

Routes only your project's files list (Next.js, SvelteKit and Astro route folders) need the CLI, as do menus opened, other browsers, screenshots and reports.

To try it before it's in the Chrome Web Store, build it and load it unpacked:

```bash
npm install && npm run build:extension
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick `packages/extension/dist`.

## Fix it with your coding agent

breakhound doesn't edit your code: your own agent does, and breakhound checks its work. Nothing leaves your machine and it costs nothing.

### Over MCP (recommended)

```bash
npx @seybel/breakhound mcp install
```

It finds Claude Code, Cursor, VS Code, Windsurf and Codex, shows what it will add to their MCP settings, and asks first. Then ask your agent to fix the responsive issues. It can:

| Tool | What it does |
|---|---|
| `scan` | Find every route and its issues. This becomes the baseline |
| `list_routes`, `list_issues` | What was found |
| `get_issue` | Widths, element, source file and line, measurements, likely fix and a screenshot |
| `verify` | Scan again and compare with the baseline: fixed, still there, and **new** |
| `checkpoint` | Commit the fix for some routes as its own git commit |
| `undo` | Revert the fixes for some routes, or the whole session |

`verify` is the point: agents often fix 812px and break 1280px, or fix one page and break another that shares a component. New issues show up there, at any width, on any page that was scanned.

The dev server stays up between calls, so each verify only takes as long as the scan. In Claude Code, `/mcp__breakhound__fix` asks for the whole loop in one go.

### From the browser

Scanned a page in the breakhound extension? Click **Send to agent** and the issues go to the agent working on that app, with nothing to copy and paste. Then ask it to "fix the breakhound issues".

- It goes to the project, not to one agent: Claude Code and Cursor open on the same app both see it.
- breakhound picks the project serving the page, the way the CLI recognises your dev server (or from `baseUrl` in your config). When it can't tell, for a staging site say, it asks which project.
- When the agent verifies a fix, the panel scans those pages again **in your browser**: same login, same browser, so the comparison is exact. Keep the panel open while it works; a chip in the toolbar shows the agent is connected. If the panel is closed, verify says so, and the agent asks you to open it.

It works through the MCP server, so it needs `npx @seybel/breakhound mcp install` once (the panel shows the command if your agent isn't connected yet). `breakhound mcp` listens on 127.0.0.1 only, on a port from 47821, and answers only the breakhound extension. It only ever writes the scan you sent into `.breakhound/`; it never reads or sends your files.

### With a prompt

```bash
npx @seybel/breakhound prompt --copy
```

Paste it into any agent. It lists each unique issue once with the widths, the element, the evidence and the likely fix, and tells the agent to run `npx @seybel/breakhound verify` until nothing is left.

### With your own model

No agent at hand? `breakhound fix` works through the last scan's issues itself, using your own API key or a model running on your machine:

```bash
ANTHROPIC_API_KEY=... npx @seybel/breakhound fix          # or OPENAI_API_KEY=... with --model <name>
npx @seybel/breakhound fix --provider ollama --model qwen2.5-coder   # free and local, with Ollama
```

For each issue it shows the model the issue and the files most likely behind it (where the element is written, then the files that mention its classes), applies the edits it suggests, and checks the pages again. A fix that clears the issue without breaking anything else, at any width, becomes its own commit, which `breakhound undo` can take back. One that doesn't is put back, and the model gets one more try with the reason. Files with uncommitted changes are never touched. It needs a git repository, and only the code around each issue is sent to the model you chose.

### Verify, checkpoint, undo

The same loop works from the command line:

```bash
npx @seybel/breakhound verify /pricing      # compare with the last full scan
npx @seybel/breakhound checkpoint /pricing -m "Let the pricing table shrink"
npx @seybel/breakhound undo /pricing        # revert just that fix
npx @seybel/breakhound undo --session       # revert every fix since the scan
npx @seybel/breakhound undo                 # list the fixes you can undo
```

Checkpoints are ordinary commits with a `Breakhound-Route:` trailer, and undo makes a new commit that reverts them: history is never rewritten. breakhound never commits changes you had before the scan (it stops and says so), and undo refuses to run over uncommitted work.

### Point the agent at the right line

In development, breakhound reads where elements come from out of React's and Vue's dev info, which usually gives the component and its file. For the exact line of every element, add the plugin (development only, production builds are untouched):

```ts
// vite.config.ts (React, Vue, Svelte, Preact, Solid; Nuxt: under `vite.plugins`)
import breakhound from '@seybel/breakhound/vite';
export default defineConfig({ plugins: [breakhound(), react()] });
```

```js
// next.config.mjs (Turbopack and webpack)
import { withBreakhound } from '@seybel/breakhound/next';
export default withBreakhound({ /* your config */ });
```

```js
// webpack.config.js
const { BreakhoundPlugin } = require('@seybel/breakhound/webpack');
module.exports = { plugins: [new BreakhoundPlugin()] };
```

Each HTML element gets a `data-bh-src="src/components/Nav.tsx:42:7"` attribute on the dev server, and reports and prompts show `Source: src/components/Nav.tsx:42`.

## Configuration

Optional. `npx @seybel/breakhound init` creates one. If breakhound is in your dev dependencies you get `breakhound.config.ts` (or `.mjs` without TypeScript), fully typed:

```ts
import { defineConfig } from '@seybel/breakhound';

export default defineConfig({
  exclude: ['/admin/**'],                       // or include: ['/blog/**']
  samples: { '/products/[id]': '/products/42' },
  widths: { min: 320, max: 1920 },
  ignore: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }],
  detectors: { 'tiny-text': false, 'edge-gutter': 'info' },
  failOn: 'error',
});
```

Running breakhound through `npx` without installing it, you get `breakhound.config.json` instead. A TypeScript file importing a package that isn't installed would break your project's own type check (and builds that run it, like `next build`). The JSON file points at breakhound's schema, so your editor still suggests and explains every option:

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@seybel/breakhound/dist/schema.json",
  "exclude": ["/admin/**"]
}
```

`.js`, `.cjs` and `.mts` configs work too. The types ship for both `import` and `require`.

| Option | What it does |
|---|---|
| `baseUrl` | Scan this server instead of finding or starting the dev server |
| `routes` | Scan exactly these routes instead of discovering them |
| `include`, `exclude` | Route globs: `*` is one segment, `**` any number |
| `samples` | A real URL for each dynamic route |
| `maxRoutes` | Most routes per run (default 100) |
| `server` | How to start the app: `{ command: 'npm run preview', port: 4173, timeout: 120 }` |
| `widths` | `{ min, max, step }` in CSS pixels |
| `ignore`, `detectors` | Leave elements out, turn checks off or change their severity |
| `failOn` | Exit 1 at `error`, `warning`, `info` or `none` |
| `vision` | `true` to add a vision model's opinion, or `{ model, provider, widths }` |
| `fix` | The model `breakhound fix` uses: `{ provider: 'ollama', model: 'qwen2.5-coder' }` |
| `browsers` | Engines to check in: `["chromium", "webkit", "firefox"]` (default Chromium only) |
| `states` | Most menus, dialogs and expandable sections to open per page (default 5), or `false` |
| `concurrency` | Browser tabs to use at once (default half your CPU cores, up to 4) |
| `memoryLimit` | Most memory the dev server and browser may use together, e.g. `"6GB"`, `"50%"` or `"off"` (default 60% of your memory) |

You can also mark elements in your markup:

```html
<div data-breakhound-ignore>...</div>                      <!-- every check -->
<div data-breakhound-ignore="overlap small-tap-target">...</div>
```

## CLI

Run these with `npx @seybel/breakhound`, or as `breakhound` once it's installed in your project (in npm scripts, for example).

```
breakhound                     Find your app and scan every route
breakhound /pricing /blog      Scan only these routes of your app
breakhound <url or file ...>   Scan just these pages
breakhound login [route]       Log in once in a browser window; later scans reuse the session
breakhound report              Open the last HTML report
breakhound prompt              Print the fix prompt (--copy to copy it, --all to include info)
breakhound init                Create a config file
breakhound install [browsers]  Download Chromium, or webkit and firefox (--with-deps adds Linux libraries)

breakhound verify [routes]     Scan again and compare with the last full scan (--all to count info)
breakhound checkpoint <routes> Commit the current changes as the fix for these routes (-m message)
breakhound undo [routes]       Revert the fixes for these routes (--session for all)
breakhound mcp install         Add the MCP server to your agents (--client, --yes)
breakhound mcp                 Run the MCP server (your agent starts it)

--url <url>             Where your app runs (skips finding the dev server)
--include <glob>        Only scan matching routes (repeatable)
--exclude <glob>        Skip matching routes (repeatable)
--max-routes <n>        Most routes to scan (default 100)
--min <px> --max <px>   Width range (default 320 to 1920)
--fail-on <level>       Exit 1 at error, warning, info or none (default error)
--pdf                   Also write report.pdf
--no-screenshots        Skip screenshots
--no-states             Don't open menus, dialogs and expandable sections
--browsers <list>       Also check other engines, e.g. chromium,webkit,firefox
--vision                Also ask your own vision model what looks off (info only)
--concurrency <n>       Browser tabs to use at once
--memory-limit <size>   Memory the dev server and browser may use, e.g. 6GB, 50% or off
--out <dir>             Report folder (default .breakhound)
--open                  Open the report when done
-q, --quiet             Only print errors
```

A scan never gets to freeze your computer. While it runs, breakhound watches the memory of the dev server it started (and everything that server runs) and of its browser, along with how much memory your system has left. If they grow past `memoryLimit`, or the system runs out of memory, it shuts them down at once and tells you what used the memory and what to try. It only ever stops processes it started itself.

Exit codes: `0` clean, `1` issues at or above `--fail-on`, `2` a page couldn't be checked (it failed to load, answered with an HTTP error, or rendered nothing). Pages behind a login and dynamic routes without a URL are reported but don't fail the run.

## CI

On GitHub Actions, after installing your dependencies:

```yaml
- uses: Seybel/breakhound@v1
  with:
    fail-on: error
    # url: ${{ steps.deploy.outputs.preview-url }}   # or scan a preview deployment
```

It starts your dev server (or scans `url`), turns each issue into an annotation, adds the summary to the job page, and uploads the report as an artifact.

Anywhere else, `npx @seybel/breakhound install --with-deps && npx @seybel/breakhound` does the same job; `CI=true` keeps it from opening windows or asking questions.

## Development

```bash
npm install
npx playwright install chromium
npm test            # accuracy suite in real Chromium, plus unit tests
npm run typecheck
npm run lint
npm run build       # builds the publishable package in packages/cli/dist
npm run build:extension   # builds the DevTools panel in packages/extension/dist
npm run dev -- http://localhost:3000
```

`fixtures/pages` is the accuracy benchmark: pages with planted bugs (marked with `data-bh-expect`) and pages full of tricky-but-fine patterns that must stay clean. Every detector change has to keep it at 100%.

Found a false positive, or a bug breakhound missed? That's the most useful thing to report: see [CONTRIBUTING.md](https://github.com/Seybel/breakhound/blob/main/CONTRIBUTING.md). How it all works is in [docs/DESIGN.md](https://github.com/Seybel/breakhound/blob/main/docs/DESIGN.md).

## License

MIT
