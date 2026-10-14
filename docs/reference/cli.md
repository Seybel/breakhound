# Command line

Run these with `npx @seybel/breakhound`, or as `breakhound` after `npm i -g @seybel/breakhound`. Installed in a project, it's `npx breakhound` or an npm script.

```
breakhound                     Find your app and scan every route
breakhound /pricing /blog      Scan only these routes of your app
breakhound <url or file ...>   Scan just these pages
breakhound login [route]       Log in once in a browser window; later scans reuse the session
breakhound report              Open the last HTML report
breakhound prompt              Print the fix prompt (--copy to copy it, --all to include info)
breakhound init                Create a config file
breakhound install [browsers]  Download Chromium, or webkit and firefox (--with-deps adds Linux libraries)

breakhound verify [routes]     Scan again and compare with the last full scan (--all to count info)
breakhound checkpoint <routes> Commit the current changes as the fix for these routes (-m message)
breakhound undo [routes]       Revert the fixes for these routes (--session for all)
breakhound mcp install         Add the MCP server to your agents (--client, --yes)
breakhound mcp                 Run the MCP server (your agent starts it)

--url <url>             Where your app runs (skips finding the dev server)
--include <glob>        Only scan matching routes (repeatable)
--exclude <glob>        Skip matching routes (repeatable)
--max-routes <n>        Most routes to scan (default 100)
--min <px> --max <px>   Width range (default 320 to 1920)
--fail-on <level>       Exit 1 at error, warning, info or none (default error)
--pdf                   Also write report.pdf
--no-screenshots        Skip screenshots
--no-states             Don't open menus, dialogs and expandable sections
--browsers <list>       Also check other engines, e.g. chromium,webkit,firefox
--vision                Also ask your own vision model what looks off (info only)
--concurrency <n>       Browser tabs to use at once
--memory-limit <size>   Memory the dev server and browser may use, e.g. 6GB, 50% or off
--out <dir>             Report folder (default .breakhound)
--open                  Open the report when done
-q, --quiet             Only print errors
```

While it runs, breakhound watches the memory of the dev server it started (and everything that server runs) and of its browser, along with how much memory your system has left. If they grow past `memoryLimit`, or the system runs out of memory, it shuts them down at once and tells you what used the memory and what to try. It only ever stops processes it started itself.

Exit codes: `0` clean, `1` issues at or above `--fail-on`, `2` a page couldn't be checked (it failed to load, answered with an HTTP error, or rendered nothing). Pages behind a login and dynamic routes without a URL are reported but don't fail the run.
