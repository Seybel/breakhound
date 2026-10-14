# What it checks

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

## Safari and Firefox

Chromium finds most layout bugs, but Safari and Firefox lay some things out differently (flex gaps, `dvh` units, form controls, font metrics). `--browsers chromium,webkit,firefox` checks the pages again in WebKit (Safari's engine) and Firefox once Chromium is done, one browser at a time so memory stays flat. An issue that shows up in only some of them says so: `(only in WebKit)`. Each extra browser is a one-time download of about 80 to 90 MB, done on first use or ahead of time with `npx @seybel/breakhound install webkit firefox`.

Two differences you'll meet early: Safari gives buttons, inputs and selects an 11px font unless you set one (Chrome and Firefox use about 13px), so unstyled controls show up as tiny text only in WebKit, with `font: inherit` as the fix (that's WebKit on a Mac: Playwright's WebKit on Linux, as in most CI, draws them like Chrome); and Firefox breaks long URLs at their slashes, so a URL that pushes the page wide in Chrome and Safari can wrap fine in Firefox.

## Menus, dialogs, tabs and expandable sections

A lot of what breaks on a phone is hidden until you tap: the mobile menu, a sign-up modal, an FAQ answer, the second tab. After scanning a page as it loads, breakhound opens what it finds there one at a time and sweeps the widths where each can be opened. That covers buttons with `aria-expanded`, `<details>`, popovers, dialogs, tabs (`role="tab"`, as in Radix, shadcn/ui, Headless UI and MUI), Bootstrap toggles, and buttons that are clearly a menu (`hamburger`, `menu-toggle`, an accessible name of "Menu"). Only what breaks while something is open gets reported, with what to open first:

```
✖ 320–399px  Page scrolls horizontally (80px wider than the viewport), with "Menu" open
```

It never clicks a link to another page or a button that submits a form, and it opens only one question of an FAQ, since they all share a layout, but every tab, since each shows something different. It opens up to 5 per page. Set `states` to change that, or `--no-states` (or `data-breakhound-ignore="states"` on an element) to leave them closed.

## A second opinion from a vision model (optional)

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
