# breakhound

Find where your layout breaks across every viewport width, then hand the fix to your coding agent.

Instead of dragging the browser or clicking through device presets, breakhound sweeps each page from 320px to 1920px in a real browser, finds the exact pixel where things go wrong, and tells you why:

```
breakhound 0.1.0 · 3 pages · 320–1920px

  ✖ /pricing   2 issues · layout changes at 768, 1024   4.1s
  ✔ /about     clean · layout changes at 640, 1024      3.2s
  ✖ /blog      1 issue · layout changes at 768          3.8s

  3 issues on 2 pages

  ✖ error    320–599px      Page scrolls horizontally (280px wider than the viewport)
              div.pricing-table · /pricing
              → It stays 600px wide no matter the screen size. Replace the fixed width
                with max-width: 100% (or a fluid width) so it can shrink.
  ⚠ warning  768–919px      Row of 6 items wraps onto 2 lines
              header nav ul · /pricing, /blog
              → Collapse this row into a menu below this width, tighten its spacing, or
                let it scroll sideways.

  Report  .breakhound/report.html
  Fix it  breakhound prompt --copy  then paste into your coding agent
```

> **Status:** pre-release. Scanning, reports and the agent prompt work today. Zero-config route discovery and the MCP fix loop are next. See [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Start your dev server, then:

```bash
npx breakhound http://localhost:3000
```

Or set it up once for your project:

```bash
npx breakhound init     # creates breakhound.config.ts and ignores .breakhound/
npx breakhound          # scans the routes in your config
```

Chromium is downloaded automatically the first time (about 150 MB).

## What it checks

| Check | Finds |
|---|---|
| `page-overflow` | Anything that makes the page scroll sideways, or gets cut off at the screen edge (including inside full-width wrappers) |
| `content-overflow` | Content spilling out of a card, panel or bordered box |
| `media-overflow` | Images, video and embeds that don't shrink with their container |
| `overlap` | Content painted on top of other content |
| `unexpected-wrap` | Nav rows and button labels breaking onto extra lines |
| `clipped-text` | Text cut off by a fixed-size container at narrower widths |
| `squished-text` | Columns so narrow that words break apart |
| `distorted-media` | Images stretched or squashed out of proportion |
| `small-tap-target` | Buttons and links under 24×24px that crowd each other on touch screens (WCAG 2.2) |
| `tiny-text` | Text under 12px on phones |
| `edge-gutter` | Text pressed against the edge of a phone screen |
| `viewport-meta` | A missing responsive viewport tag |

Every issue comes with the exact width ranges where it happens, the element to blame, the numbers behind it, a screenshot, and a likely fix. breakhound also reports the widths where your layout actually changes and flags changes that no media query explains.

It's built to be quiet: carousels, off-canvas menus, badges, decorative shapes, ellipsis and line-clamp, and framework dev overlays are all understood and left alone.

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

`breakhound.config.ts` (or `.js`, `.mjs`, `.json`):

```ts
import { defineConfig } from 'breakhound';

export default defineConfig({
  baseUrl: 'http://localhost:3000',
  routes: ['/', '/pricing', '/blog/hello-world'],
  widths: { min: 320, max: 1920 },
  ignore: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }],
  detectors: { 'tiny-text': false, 'edge-gutter': 'info' },
  failOn: 'error',
});
```

You can also mark elements in your markup:

```html
<div data-breakhound-ignore>...</div>                      <!-- every check -->
<div data-breakhound-ignore="overlap small-tap-target">...</div>
```

## CLI

```
breakhound [url or path ...]   Scan pages (defaults to the routes in your config)
breakhound report              Open the last HTML report
breakhound prompt              Print the fix prompt (--copy to copy it, --all to include info)
breakhound init                Create a config file

--min <px> --max <px>   Width range (default 320 to 1920)
--fail-on <level>       Exit 1 at error, warning, info or none (default error)
--pdf                   Also write report.pdf
--no-screenshots        Skip screenshots
--out <dir>             Report folder (default .breakhound)
--open                  Open the report when done
-q, --quiet             Only print errors
```

Exit codes: `0` clean, `1` issues at or above `--fail-on`, `2` a page couldn't be scanned. That makes it CI-friendly as is.

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
