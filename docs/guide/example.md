# Try it on an example

The repository has a small site with five responsive bugs left in on purpose, and no dependencies, so you can see what breakhound does before running it on your own app.

```bash
git clone https://github.com/Seybel/breakhound.git
cd breakhound/examples/acme
npx @seybel/breakhound
```

breakhound starts the site with its `dev` script, follows its links to all three pages, and finds:

| Page | Bug | Widths |
|---|---|---|
| `/` | The heading keeps its 64px desktop size, so a word of it is wider than a small phone | 320 to 470px |
| `/` `/pricing` `/about` | Six fixed-width nav links wrap onto two lines before the menu button takes over | 768 to 907px |
| `/pricing` | The comparison table is 640px wide at every width | 320 to 659px |
| `/about` | The photo is a fixed 280px in a column narrower than that, and covers the text | 640 to 879px |

Then try the fixing loop: `npx @seybel/breakhound mcp install` and ask your coding agent to fix the breakhound issues, or `npx @seybel/breakhound prompt --copy` and paste it in.

To try the [Chrome extension](/guide/extension) on it, run `npm run dev`, open `http://localhost:4173` and right-click the page: **Scan with breakhound**.
