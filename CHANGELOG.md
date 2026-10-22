# Changelog

## 1.0.9

- The extension always opens on **This page**. Before, it remembered **Whole site** from the last time, so right-clicking **Scan with breakhound** could start a whole-site scan.
- The extension's start button and heading say what it's about to scan: **Scan this page** or **Scan whole site**.
- The toolbar button says **Scan again** only when it would repeat the same kind of scan, and **Scan** after switching between This page and Whole site.

## 1.0.8

- The extension no longer reports false issues on pages that adjust their layout in a resize handler (a debounced resize, say) when scanning without **Reload first**. It now waits for those handlers the way the CLI does, so both find the same issues.

## 1.0.7

- A shorter README, with the details on the docs site.

## 1.0.6

- Works at the root of a monorepo: breakhound finds the app in your workspaces, or with several apps, the one that's running.
- When the dev server is already running and the dev command exits because of it (as Next.js does), breakhound uses the running app instead of failing.
- The extension explains how to scan a page opened from a file, and opens the setting Chrome needs for it, instead of failing with Chrome's error.

## 1.0.5

- Clearer examples for dynamic routes and `params` in the docs, `--help` and config errors.

## 1.0.4

- Tabs are scanned too. Each tab that isn't selected (`role="tab"`, as in Radix, shadcn/ui, Headless UI and MUI) is opened in turn, so a layout that breaks only on the second tab is found, as `with the "Billing" tab open`.
- Tabs scrolled out of sight in a tab bar that scrolls sideways are opened too.
- Menus whose button changes its class when opened, like Bootstrap's `navbar-toggler collapsed`, are scanned open again. They were skipped before.

## 1.0.3

- Dynamic routes below a page that was found reuse its values: once `/users/jane` is scanned, `/users/[username]/settings` is too, with no config.
- New `params` option gives dynamic route parameters a real value by name, for every route that uses them: `params: { username: 'jane', orderId: '1001' }`. The hint for routes left out names just the parameters still missing.
- The HTML report shows the breakhound logo.

## 1.0.2

- `breakhound mcp install` sets up Antigravity too, in the project's `.agents/mcp_config.json`.
- `breakhound fix` without a model now says that a coding agent doesn't need one, and how to connect it.
- The docs and `--help` say how to get a `breakhound` command of your own.

## 1.0.1

- **Send to agent** works with the extension from the Chrome Web Store.
- The extension no longer reports text as squeezed when a narrow cell is mostly inline code or links.
- Cleaner package build, with no warnings.

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
