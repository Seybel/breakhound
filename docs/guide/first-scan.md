# Your first scan

A whole session from start to finish: scan, read the results, fix one issue, check the fix, and take it back. It uses the example site in the repository, so you can follow along exactly, then do the same in your own project.

## 1. Run it

```bash
git clone https://github.com/Seybel/breakhound.git
cp -R breakhound/examples/acme acme && cd acme
git init && git add -A && git commit -m "Acme site"   # checkpoint and undo work through git
npx @seybel/breakhound
```

In your own project, run only the last line from the project folder. The first run downloads Chromium (about 150 MB, once).

## 2. Read the results

```
Starting the app with npm run dev...
✔ App started at http://localhost:4173
• No route list found for this app, so breakhound follows links from / (up to 50 pages)
breakhound 1.0.9 · following links · 320–1920px

  ✖ /             3 issues · layout changes at 500, 760, 768, 908  5.4s
  ✖ /about        2 issues · layout changes at 640, 768, 908  5.2s
  ✖ /pricing      2 issues · layout changes at 500, 740, 768, 908  5.3s

  5 issues on 3 pages

  ✖ error    320–659px      Page scrolls horizontally (340px wider than the viewport)
              table.compare · /pricing
              → It stays 640px wide no matter the screen size. Replace the fixed width
                with max-width: 100% (or a fluid width) so it can shrink.
  ⚠ warning  768–907px      Row of 6 items wraps onto 2 lines
              ul.menu · /, /pricing, /about
              → Collapse this row into a menu below this width, tighten its spacing, or
                let it scroll sideways.
  ...

  Report  .breakhound/report.html  (npx @seybel/breakhound report to open it)
  Fix it  npx @seybel/breakhound prompt --copy  then paste into your coding agent
      or  npx @seybel/breakhound mcp install  so your agent can scan, verify and undo by itself
```

What each part tells you:

- **The first lines** are how it found your app: it started the dev server with your `dev` script (or used the one already running) and found the pages, here by following links. A Next.js, Nuxt, SvelteKit or Astro app gets its routes from its files instead.
- **One line per page:** how many issues, and the widths where the layout changes (a media query kicking in, a row wrapping).
- **One block per issue**, worst first:
  - `✖ error`, `⚠ warning` or `ℹ info`: errors are clearly broken (the page scrolls sideways, things overlap), warnings are worth a look (a nav row wrapping), and info is a note (small text, for example). Only errors fail the run, unless you change that with `--fail-on`.
  - `320–659px`: the exact widths where it happens. Below 660px here; fine from 660px up.
  - `table.compare · /pricing`: the element to blame, and every page it's on. An issue in a shared header is listed once, with all its pages.
  - `→`: the likely fix.
- **The report** at `.breakhound/report.html` has the same issues with a screenshot of each at its worst width, a map of every width, and copy buttons. Open it with `npx @seybel/breakhound report`.

The `.breakhound/` folder ignores itself in git, so there's nothing to add to `.gitignore`.

## 3. Fix it

Pick whichever suits you.

**With a coding agent over MCP (recommended).** Set it up once:

```bash
npx @seybel/breakhound mcp install
```

Restart your agent, then ask it to "fix the breakhound issues" (in Claude Code, `/mcp__breakhound__fix`). No breakhound tools in your agent? [Check it's switched on](./agents#not-connected). It reads the issues, edits your code, and checks each fix at every width itself, so you can skip to step 5.

**With any agent, by pasting.**

```bash
npx @seybel/breakhound prompt --copy
```

Paste it into the chat. It lists each issue once with its widths, element, measurements and likely fix, and tells the agent how to check its work.

**By hand.** Follow the `→` line. For the pricing table, the fix is to let it shrink and scroll inside its own box:

```css
.compare {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
```

## 4. Check the fix

```bash
npx @seybel/breakhound verify /pricing
```

```
breakhound 1.0.9 · 1 page · 320–1920px

  ✖ /pricing      1 issue · layout changes at 500, 740, 768, 908  4.6s

Checked 1 page against the scan from 14 Oct 2026, 13:18.
Fixed: 1 · Still there: 1 · New: 0

Fixed:
- /pricing  320–659px  [error] Page scrolls horizontally (340px wider than the viewport)  `table.compare`

Still there:
- /pricing  768–907px  [warning] Row of 6 items wraps onto 2 lines  `ul.menu`

Not done yet. Fix what is still there or new, then verify again.
```

`verify` scans the page again at every width and compares it with your first scan. **New** is the number to watch: a fix that makes things worse at some other width, or on another page, shows up there. Leave out the route to check every page from the first scan.

## 5. Keep it, or take it back

Commit the fix for that page on its own, so it can be undone later without touching anything else:

```bash
npx @seybel/breakhound checkpoint /pricing -m "Let the pricing table scroll on small screens"
```

```
✔ Committed 1f9c124: Let the pricing table scroll on small screens
```

It's an ordinary git commit, tagged with the page it fixed. See what you can take back, and take it back:

```bash
npx @seybel/breakhound undo
```

```
  1f9c124504  /pricing  Let the pricing table scroll on small screens
```

```bash
npx @seybel/breakhound undo /pricing
```

```
✔ Undid 1 fix in commit 8cfe0fd
```

Undo adds a new commit that reverses the fix; your history is never rewritten. `undo --session` takes back every fix since the scan.
