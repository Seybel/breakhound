# breakhound

[![npm](https://img.shields.io/npm/v/@seybel/breakhound)](https://www.npmjs.com/package/@seybel/breakhound) [![CI](https://github.com/Seybel/breakhound/actions/workflows/ci.yml/badge.svg)](https://github.com/Seybel/breakhound/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Seybel/breakhound/blob/main/LICENSE) [![Docs](https://img.shields.io/badge/docs-seybel.github.io%2Fbreakhound-6d28d9)](https://seybel.github.io/breakhound/)

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
  ...

  ✖ error    320–599px      Page scrolls horizontally (280px wider than the viewport)
              div.pricing-table · /pricing
              → It stays 600px wide no matter the screen size. Replace the fixed width
                with max-width: 100% (or a fluid width) so it can shrink.
  ⚠ warning  768–919px      Row of 6 items wraps onto 2 lines
              header nav ul · /pricing, /blog/[slug]
              → Collapse this row into a menu below this width, tighten its spacing, or
                let it scroll sideways.

  Report  .breakhound/report.html  (npx @seybel/breakhound report to open it)
  Fix it  npx @seybel/breakhound mcp install  so your agent can scan, verify and undo by itself
```

## Quick start

In your project folder:

```bash
npx @seybel/breakhound
```

No config needed. It works with Next.js, Nuxt, SvelteKit, Astro, Remix, React Router, TanStack Router, Vue, Angular and plain Vite apps, at the root of a monorepo too, and follows links on anything else. Chromium downloads the first time (about 150 MB).

To type `breakhound` on its own, install it globally with `npm i -g @seybel/breakhound`, or add it to your project with `npm i -D @seybel/breakhound`.

## What it finds

Pages that scroll sideways, content spilling out of its box, media that doesn't shrink, overlapping content, nav rows and labels that wrap, clipped and squished text, text too small or too big for phones, small tap targets, distorted images, text against the screen edge, and a missing viewport tag.

Every issue comes with the exact widths where it happens, the element to blame, the numbers behind it, a screenshot, and a likely fix. It also opens menus, dialogs, tabs and accordions and checks them open, can check Safari's and Firefox's engines too, and is built to stay quiet on carousels, off-canvas menus and other patterns that only look wrong. [All the checks →](https://seybel.github.io/breakhound/guide/checks)

## Three ways to use it

**In the terminal**, as above. Pages behind a login, dynamic routes, staging servers and big apps are all covered in [recipes](https://seybel.github.io/breakhound/guide/recipes).

**In Chrome**, with the [breakhound extension](https://chromewebstore.google.com/detail/ddnmhnjmcokbfabeileblceehjhefkpc): right-click any page, from localhost to production, and choose **Scan with breakhound**. A timeline fills in live as the page grows from 320px to 1920px. [More →](https://seybel.github.io/breakhound/guide/extension)

**With your coding agent.** breakhound doesn't edit your code: your agent does, and breakhound checks its work at every width.

```bash
npx @seybel/breakhound mcp install
```

That sets it up for Claude Code, Cursor, VS Code, Antigravity, Windsurf and Codex. Then ask your agent to fix the responsive issues: it can scan, verify that each fix didn't break another width or page, commit each fix on its own, and undo it. No MCP? `npx @seybel/breakhound prompt --copy` gives you instructions to paste into any agent. [More →](https://seybel.github.io/breakhound/guide/agents)

## In CI

```yaml
- uses: Seybel/breakhound@v1
  with:
    fail-on: error
```

It starts your dev server (or scans a preview deployment), turns each issue into an annotation, and uploads the report as an artifact. [More →](https://seybel.github.io/breakhound/guide/ci)

## Docs

- [Getting started](https://seybel.github.io/breakhound/guide/getting-started) and [your first scan](https://seybel.github.io/breakhound/guide/first-scan)
- [Recipes](https://seybel.github.io/breakhound/guide/recipes) for common jobs
- [Configuration](https://seybel.github.io/breakhound/reference/config) and the [CLI](https://seybel.github.io/breakhound/reference/cli)

## Contributing

Found a false positive, or a bug breakhound missed? That's the most useful thing to report. See [CONTRIBUTING.md](https://github.com/Seybel/breakhound/blob/main/CONTRIBUTING.md) for that and for working on the code.

## License

MIT
