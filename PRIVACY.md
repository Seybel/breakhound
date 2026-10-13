# Privacy

breakhound collects nothing. There are no accounts, no analytics, no tracking and no servers of ours.

## The Chrome extension

- It reads and resizes only the tab you scan, and only when you start a scan or pick a width. It needs Chrome's `debugger` permission to do that, and Chrome shows a bar while it's attached.
- What it finds stays in the panel. It's gone when you close the panel, apart from your settings (the widths you picked, whole site or one page), which are kept in your browser.
- **Copy prompt** puts the issues on your clipboard, for you to paste where you like.
- **Send to agent** sends the issues to `breakhound mcp` running on your own computer, at `127.0.0.1`, which writes them into your project's `.breakhound/` folder for your coding agent. Nothing goes over the internet. To offer this, the panel checks whether `breakhound mcp` is running on your computer (ports 47821 to 47830 of `127.0.0.1`). The extension remembers which project folder each site was sent to, in your browser, so it can send there again.

## The command line tool

- It scans your app in a browser on your computer and writes its reports into your project's `.breakhound/` folder.
- `breakhound login` saves the browser session you log in with to `.breakhound/auth.json`, on your computer. breakhound never sees your password.
- `breakhound fix` and `--vision` send parts of your code, or screenshots of your pages, to the model provider you choose with your own API key (Anthropic or OpenAI), under that provider's terms. With a local model (Ollama), nothing leaves your computer. Neither runs unless you ask for it.
- Downloading a browser (`breakhound install`) fetches it from Playwright's servers, as Playwright does.

## Contact

Questions go to [GitHub issues](https://github.com/Seybel/breakhound/issues).
