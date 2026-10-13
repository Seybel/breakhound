# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/Seybel/breakhound/security/advisories/new), not in a public issue. I'll reply within a few days and credit you in the release notes unless you'd rather not be named.

## What breakhound can reach

These are the parts worth looking at closely:

- **The browser extension** uses Chrome's `debugger` permission to resize the tab you scan and run its checks there. It only attaches when you start a scan or pick a width, and Chrome shows a bar while it's attached. It sends nothing anywhere, except the scan you choose to send to your own `breakhound mcp` (below).
- **`breakhound mcp`** is started by your coding agent and talks to it over stdio. For the extension's **Send to agent**, it also listens on `127.0.0.1` (ports 47821 to 47830). It answers only requests carrying the breakhound extension's origin, with a `Host` of `127.0.0.1` or `localhost` on that port (so a web page can't reach it through DNS rebinding). It only accepts well-formed scan results, and only writes them into the project's `.breakhound/` folder. It never sends your files over that port: only the project's name and folder, so the panel can tell projects apart.
- **`breakhound login`** saves a browser session to `.breakhound/auth.json`. The folder ignores itself in git, and breakhound never sees your password.
- **`breakhound fix`** sends the code around each issue to the model you choose (your own API key, or a local model).
- **Starting your dev server:** breakhound runs your project's `dev` script when no server is running, the same way `npm run dev` would.

## Supported versions

Fixes go into the latest release.
