# Fix it with your coding agent

breakhound doesn't edit your code: your own agent does, and breakhound checks its work. Nothing leaves your machine and it costs nothing.

## Over MCP (recommended)

```bash
npx @seybel/breakhound mcp install
```

It finds Claude Code, Cursor, VS Code, Antigravity, Windsurf and Codex, shows what it will add to their MCP settings, and asks first. Then ask your agent to fix the responsive issues. It can:

| Tool | What it does |
|---|---|
| `scan` | Find every route and its issues. This becomes the baseline |
| `list_routes`, `list_issues` | What was found |
| `get_issue` | Widths, element, source file and line, measurements, likely fix and a screenshot |
| `verify` | Scan again and compare with the baseline: fixed, still there, and **new** |
| `checkpoint` | Commit the fix for some routes as its own git commit |
| `undo` | Revert the fixes for some routes, or the whole session |

`verify` is the point: agents often fix 812px and break 1280px, or fix one page and break another that shares a component. New issues show up there, at any width, on any page that was scanned.

The dev server stays up between calls, so each verify only takes as long as the scan. A scan or verify still going after about 45 seconds answers that it's still running, and what it's waiting for, instead of letting your agent's call time out; the agent calls it again to get the result. In Claude Code, `/mcp__breakhound__fix` asks for the whole loop in one go.

## When your agent doesn't see breakhound {#not-connected}

Setting it up adds breakhound to your agent's MCP settings, but your agent decides when to run it. If it has no breakhound tools, or the extension says no coding agent is connected, check these.

**The project folder is open in your agent.** breakhound runs for the folder your agent has open. Claude Code, Cursor, VS Code and Antigravity read it from the project's own settings, so a window with no folder open, or another folder, has no breakhound. Windsurf and Codex have one setting for every project, so open or start them in the project folder.

**breakhound is switched on.** Each agent asks for this its own way:

| Agent | Set up in | Switch it on |
|---|---|---|
| Claude Code | `.mcp.json` | Approve breakhound when Claude Code asks, the first time you start it in the project. Dismissed it? `/mcp` lists each server, whether it's connected, and lets you approve it. |
| Cursor | `.cursor/mcp.json` | **Cursor Settings → Tools & MCP**: switch breakhound on. If it's on but shows no tools, switch it off and on again, or click its refresh icon. |
| VS Code | `.vscode/mcp.json` | Click **Start** above breakhound in `.vscode/mcp.json`, and trust it when asked. Or run **MCP: List Servers** from the Command Palette, pick breakhound and start it; **Show Output** there says what went wrong if it stops. Its tools are for Copilot Chat in agent mode. |
| Antigravity | `.agents/mcp_config.json` | Reload its MCP servers, or restart Antigravity, with the project open. |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | In Cascade, open **Manage MCPs** and click **Refresh**. |
| Codex | `~/.codex/config.toml` | Start a new session in the project folder. `/mcp` lists the servers running in it. |

**Your agent was restarted.** Agents start their MCP servers when a session or window opens, so one added while yours was open shows up after a restart, or the refresh above.

Once it's running, the breakhound extension shows a chip with the project's name in its toolbar.

## From the browser

Scanned a page in the breakhound extension? Click **Send to agent** and the issues go to the agent working on that app, with nothing to copy and paste. Then ask it to "fix the breakhound issues".

- It goes to the project, not to one agent: Claude Code and Cursor open on the same app both see it.
- breakhound picks the project serving the page, the way the CLI recognises your dev server (or from `baseUrl` in your config). When it can't tell, for a staging site say, it asks which project.
- When the agent verifies a fix, the panel scans those pages again **in your browser**: same login, same browser, so the comparison is exact. Keep the panel open while it works; a chip in the toolbar shows the agent is connected. If the panel is closed, verify says so, and the agent asks you to open it.
- Chrome doesn't draw a tab that's out of view, so the tab has to be visible while your agent checks its fixes: beside your editor works, or switch back when asked. Your agent tells you before it checks. The first time you send, breakhound asks to show notifications; then if the tab is out of view during a check, a notification tells you, wherever you are, and clicking it brings the tab back. The check carries on by itself. (On a Mac, Chrome's notifications also need to be on in System Settings → Notifications.)

It works through the MCP server, so it needs `npx @seybel/breakhound mcp install` once (the panel shows the command if your agent isn't connected yet), and breakhound [switched on in your agent](#not-connected). `breakhound mcp` listens on 127.0.0.1 only, on a port from 47821, and answers only the breakhound extension. It only ever writes the scan you sent into `.breakhound/`; it never reads or sends your files.

## With a prompt

```bash
npx @seybel/breakhound prompt --copy
```

Paste it into any agent. It lists each unique issue once with the widths, the element, the evidence and the likely fix, and tells the agent to run `npx @seybel/breakhound verify` until nothing is left.

## With your own model

No agent at hand? `breakhound fix` works through the last scan's issues itself, using your own API key or a model running on your machine:

```bash
ANTHROPIC_API_KEY=... npx @seybel/breakhound fix          # or OPENAI_API_KEY=... with --model <name>
npx @seybel/breakhound fix --provider ollama --model qwen2.5-coder   # free and local, with Ollama
```

For each issue it shows the model the issue and the files most likely behind it (where the element is written, then the files that mention its classes), applies the edits it suggests, and checks the pages again. A fix that clears the issue without breaking anything else, at any width, becomes its own commit, which `breakhound undo` can take back. One that doesn't is put back, and the model gets one more try with the reason. Files with uncommitted changes are never touched. It needs a git repository, and only the code around each issue is sent to the model you chose.

## Verify, checkpoint, undo

The same loop works from the command line:

```bash
npx @seybel/breakhound verify /pricing      # compare with the last full scan
npx @seybel/breakhound checkpoint /pricing -m "Let the pricing table shrink"
npx @seybel/breakhound undo /pricing        # revert just that fix
npx @seybel/breakhound undo --session       # revert every fix since the scan
npx @seybel/breakhound undo                 # list the fixes you can undo
```

Checkpoints are ordinary commits with a `Breakhound-Route:` trailer, and undo makes a new commit that reverts them: history is never rewritten. breakhound never commits changes you had before the scan (it stops and says so), and undo refuses to run over uncommitted work.

## Point the agent at the right line

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
