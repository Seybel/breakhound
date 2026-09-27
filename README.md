# breakhound

Find where your layout breaks across every viewport width, then hand the fix to your coding agent.

Instead of dragging the browser or clicking through device presets, run one command in your project. breakhound finds your framework and dev server (and starts it if needed), discovers every route, sweeps each page from 320px to 1920px in a real browser, finds the exact pixel where things go wrong, and tells you why:

```
✔ Next.js running at http://localhost:3000
✔ 14 routes from src/app (2 dynamic, filled in from links on your pages)
breakhound 0.1.0 · 14 pages · 320–1920px

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

  ○ 1 page needs a login. Run breakhound login once to sign in, then scan again.

  Report  .breakhound/report.html
  Fix it  breakhound prompt --copy  then paste into your coding agent
```

> **Status:** pre-release. Scanning, route discovery, reports and the agent prompt work today. The MCP fix loop is next. See [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

In your project folder:

```bash
npx breakhound
```

That's it: no config. If your dev server is already running it's used, otherwise breakhound starts it with your `dev` script and stops it when done. Chromium is downloaded automatically the first time (about 150 MB).

Other ways to run it:

```bash
npx breakhound /pricing /blog          # only these routes
npx breakhound http://localhost:3000   # just this one page
npx breakhound --url https://staging.example.com   # every route, on another server
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
| Anything else | links followed from the home page (up to 50 pages, a few per section) |

**Dynamic routes** like `/blog/[slug]` are scanned once, using a real link found on your pages (routes that share a template share a layout). If no page links to one, it's listed with a hint, and you can give it a URL:

```ts
samples: { '/products/[id]': '/products/42' }
```

**Pages behind a login** are spotted (they redirect to a sign-in page) and listed instead of scanning the login page over and over. Sign in once:

```bash
npx breakhound login
```

A browser window opens; log in as you normally would, then press Enter. The session is saved to `.breakhound/auth.json` (added to `.gitignore`) and used by later scans. breakhound never sees your password.

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
| `edge-gutter` | Text pressed against the edge of a phone screen |
| `viewport-meta` | A missing responsive viewport tag |

Every issue comes with the exact width ranges where it happens, the element to blame, the numbers behind it, a screenshot, and a likely fix. breakhound also reports the widths where your layout actually changes and flags changes that no media query explains.

It's built to be quiet: carousels, off-canvas menus, badges, decorative shapes, ellipsis and line-clamp, and framework dev overlays are all understood and left alone. It also looks inside web components (open shadow roots) and handles right-to-left pages.

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

## Fix it with your coding agent

```bash
npx breakhound prompt --copy
```

Paste it into Claude Code, Cursor, Copilot or any other agent. The prompt lists each unique issue once with the widths, the element, the evidence and the likely fix, tells the agent not to change other widths, and asks it to re-run breakhound until nothing is left.

## Configuration

Optional. `breakhound.config.ts` (or `.js`, `.mjs`, `.json`), created by `npx breakhound init`:

```ts
import { defineConfig } from 'breakhound';

export default defineConfig({
  exclude: ['/admin/**'],                       // or include: ['/blog/**']
  samples: { '/products/[id]': '/products/42' },
  widths: { min: 320, max: 1920 },
  ignore: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }],
  detectors: { 'tiny-text': false, 'edge-gutter': 'info' },
  failOn: 'error',
});
```

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

You can also mark elements in your markup:

```html
<div data-breakhound-ignore>...</div>                      <!-- every check -->
<div data-breakhound-ignore="overlap small-tap-target">...</div>
```

## CLI

```
breakhound                     Find your app and scan every route
breakhound /pricing /blog      Scan only these routes of your app
breakhound <url or file ...>   Scan just these pages
breakhound login [route]       Log in once in a browser window; later scans reuse the session
breakhound report              Open the last HTML report
breakhound prompt              Print the fix prompt (--copy to copy it, --all to include info)
breakhound init                Create a config file
breakhound install             Download Chromium (--with-deps adds Linux system libraries)

--url <url>             Where your app runs (skips finding the dev server)
--include <glob>        Only scan matching routes (repeatable)
--exclude <glob>        Skip matching routes (repeatable)
--max-routes <n>        Most routes to scan (default 100)
--min <px> --max <px>   Width range (default 320 to 1920)
--fail-on <level>       Exit 1 at error, warning, info or none (default error)
--pdf                   Also write report.pdf
--no-screenshots        Skip screenshots
--concurrency <n>       Browser tabs to use at once
--out <dir>             Report folder (default .breakhound)
--open                  Open the report when done
-q, --quiet             Only print errors
```

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

Anywhere else, `npx breakhound install --with-deps && npx breakhound` does the same job; `CI=true` keeps it from opening windows or asking questions.

## Development

```bash
npm install
npx playwright install chromium
npm test            # accuracy suite in real Chromium, plus unit tests
npm run typecheck
npm run lint
npm run build       # builds the publishable package in packages/cli/dist
npm run dev -- http://localhost:3000
```

`fixtures/pages` is the accuracy benchmark: pages with planted bugs (marked with `data-bh-expect`) and pages full of tricky-but-fine patterns that must stay clean. Every detector change has to keep it at 100%.

## License

MIT
