# breakhound

Find where your layout breaks across every viewport width, then hand the fix to your coding agent.

Instead of dragging the browser or clicking through device presets, breakhound sweeps a page from 320px to 1920px in a real browser and tells you exactly where things go wrong:

```
  /pricing  2 issues · 3 layout breakpoints (640, 768, 1024)
    ✖ error    320–599px        Page scrolls horizontally (280px wider than the viewport)
               div.pricing-table
    ⚠ warning  768–919px        Row of 6 items wraps onto 2 lines
               ul.menu
```

> **Status:** early development. The detection engine works; zero-config route discovery, reports and the agent fix loop are on the way. See [docs/DESIGN.md](docs/DESIGN.md) for the full plan.

## What it detects

| Detector | Finds |
|---|---|
| `page-overflow` | Anything that makes the page scroll sideways, or gets cut off at the edge |
| `content-overflow` | Content spilling out of a card, panel or bordered box |
| `media-overflow` | Images, video and embeds that don't shrink with their container |
| `overlap` | Content painted on top of other content |
| `unexpected-wrap` | Nav rows and button labels breaking onto extra lines |

Every issue comes with the exact width range where it happens (bisected to the pixel), the element to blame, and the numbers behind it. breakhound also reports the widths where your layout actually changes and flags changes that no media query explains.

## Try it (from source)

```bash
npm install
npx playwright install chromium
npm run dev -- http://localhost:3000/pricing
```

## Development

```bash
npm test          # fixture accuracy suite in real Chromium
npm run typecheck
npm run lint
```

The `fixtures/pages` folder is the accuracy benchmark: pages with planted bugs (marked with `data-bh-expect`) and pages full of tricky-but-fine patterns that must stay clean.

## License

MIT
