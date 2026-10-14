# Changelog

## 1.0.0

First public release.

**Scanning**

- Finds your framework and dev server, starts it when it isn't running, and finds every route: from route files and router code (Next.js, Nuxt, SvelteKit, Astro, Remix, TanStack, Angular), from the app's live router (Vue, React Router, TanStack), or by following links.
- Sweeps each page from 320px to 1920px in a real browser and bisects to the exact width where something breaks.
- Checks: sideways scrolling, content spilling out of its box, media that doesn't shrink, overlapping content, rows and labels that wrap, clipped and squished text, text too small or too big for phones, small tap targets, distorted images, text pressed against the screen edge, and a missing viewport tag.
- Shows every width where the layout changes, and flags changes no media or container query explains.
- Opens menus, dialogs and accordions and checks them too.
- Safari's and Firefox's engines with `--browsers chromium,webkit,firefox`.
- Pages behind a login with `breakhound login`, which saves a session locally.
- Watches the memory of the dev server and browser it started, and stops them before your system runs short.

**Fixing**

- `breakhound prompt` writes instructions any coding agent can follow.
- `breakhound mcp` gives Claude Code, Cursor, VS Code, Windsurf and Codex tools to scan, verify, checkpoint and undo. `breakhound mcp install` sets it up.
- `breakhound verify` checks a fix at every width, `checkpoint` commits it on its own, and `undo` takes it back.
- `breakhound fix` fixes the issues with your own model (Anthropic, OpenAI, or a local Ollama model).
- Build plugins for Vite, Next.js and webpack point each issue at the exact file and line.

**Chrome extension**

- Scans the tab you have open, or the whole site, from the side panel or a DevTools tab.
- A timeline of every width: drag to resize the page live, click an issue to see it where it's worst.
- Quick picks for mobile, tablet and desktop widths.
- **Send to agent** hands the issues to the coding agent working on that app, and the agent checks its fixes in your browser.

**Reports and CI**

- A self-contained HTML report, a Markdown summary, and JSON results.
- A GitHub Action that annotates each issue and uploads the report.
