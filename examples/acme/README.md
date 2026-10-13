# Acme: a site with responsive bugs in it

A made-up product site with five layout bugs left in on purpose, to try breakhound on. No dependencies.

```bash
cd examples/acme
npx @seybel/breakhound
```

breakhound starts the site with its `dev` script, follows its links to all three pages, and should find:

| Page | Bug | Widths |
|---|---|---|
| `/` | The heading keeps its 64px desktop size, so a word of it is wider than a small phone | 320 to 470px |
| `/` `/pricing` `/about` | Six fixed-width nav links wrap onto two lines before the menu button takes over | 768 to 907px |
| `/pricing` | The comparison table is 640px wide at every width | 320 to 659px |
| `/about` | The photo is a fixed 280px in a column narrower than that, and covers the text | 640 to 879px |

Then try the fixing loop: `npx @seybel/breakhound mcp install` and ask your coding agent to fix the breakhound issues, or `npx @seybel/breakhound prompt --copy` and paste it in. The bugs are marked with comments in `site/styles.css`.

To try the Chrome extension on it, run `npm run dev`, open http://localhost:4173 and right-click the page: **Scan with breakhound**.
