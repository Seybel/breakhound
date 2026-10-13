# Contributing to breakhound

Thanks for helping. The most useful contributions are reports of what breakhound got wrong: a bug it flagged that isn't one, or one it missed. Both make it better for everyone.

## Reporting a wrong result

breakhound is only worth running if you can trust what it says, so false positives are treated as bugs.

- **It flagged something that's fine:** open a [false positive](https://github.com/Seybel/breakhound/issues/new?template=false-positive.yml) issue.
- **It missed something that's broken:** open a [missed bug](https://github.com/Seybel/breakhound/issues/new?template=missed-bug.yml) issue.

The best report is a small HTML page that shows the problem on its own. A page you can't share is fine too: the issue's text from `.breakhound/summary.md`, the width, and a screenshot are usually enough to rebuild it. Please don't post anything private from your app.

Until a fix lands, `data-breakhound-ignore="<check>"` on the element (or `detectors` in your config) silences one result.

## Setting up

You need Node.js 20.16 or newer.

```bash
git clone https://github.com/Seybel/breakhound.git
cd breakhound
npm install
npx playwright install chromium
npm test
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests, plus the accuracy suite on `fixtures/pages` in real Chromium |
| `npm run typecheck` | TypeScript, every package |
| `npm run lint` | Biome; `npm run format` fixes what it can |
| `npm run dev -- http://localhost:3000` | Runs the CLI from source |
| `npm run build` | Builds the npm package into `packages/cli/dist` |
| `npm run build:extension` | Builds the extension into `packages/extension/dist` (load it unpacked from `chrome://extensions`) |

`BREAKHOUND_TEST_BROWSER=webkit` or `=firefox` runs the accuracy suite in another engine (`npx playwright install webkit firefox` first).

## How the code is laid out

[docs/DESIGN.md](docs/DESIGN.md) explains how it all works. In short:

| Package | What's in it |
|---|---|
| `analyzers` | The checks. They run inside the page, so they're plain DOM code with no dependencies |
| `engine` | Drives the browser: resizes, waits for the layout to settle, sweeps and bisects widths |
| `routes` | Finds the framework, the dev server and every route |
| `source` | Maps an element back to the file and line it came from |
| `report` | The HTML report, the summary and the prompt for coding agents |
| `cli` | The `breakhound` command and the MCP server. The only package published to npm |
| `extension` | The Chrome extension: side panel and DevTools tab |

## Changing a check

Every detector change keeps the accuracy suite at 100%: every planted bug found at the right widths, and nothing flagged on the clean pages.

1. Add a page to `fixtures/pages`. A page with a bug is named `bug-*.html` and marks it with `data-bh-expect="<detector>@<from>-<to>"` on the element. A page of patterns that look wrong but aren't is named `clean-*.html` and must stay clean.
2. Make the change in `packages/analyzers/src/detectors`.
3. Run `npm test`. If an engine lays the page out differently, `!webkit` or `!firefox` on a marker leaves that engine out, with a comment saying why.

Fixture pages are synthetic: build them from scratch, and never copy markup from a real site or app.

## Pull requests

- One change per pull request, with a test that fails without it.
- `npm run lint`, `npm run typecheck` and `npm test` pass.
- User-facing text is plain and specific: say what happened and what to do next.
- New options go in the README and in `define.ts`, so the config schema picks them up.

By contributing you agree that your work is released under the [MIT License](LICENSE).
