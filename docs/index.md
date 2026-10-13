---
layout: home

hero:
  name: breakhound
  text: Find the exact width where your layout breaks
  tagline: Every page of your app, every width from 320 to 1920px, in a real browser. The pixel where it breaks, why, and a fix for your coding agent.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Chrome extension
      link: /guide/extension
    - theme: alt
      text: GitHub
      link: https://github.com/Seybel/breakhound

features:
  - title: In your terminal
    details: "One command scans every route of your Next.js, Nuxt, SvelteKit, Astro, Remix, Vite, Vue or Angular app: npx @seybel/breakhound"
    link: /guide/getting-started
  - title: In Chrome
    details: Right-click any page and choose Scan with breakhound. A timeline of every width, and each issue shown where it's worst.
    link: /guide/extension
  - title: With your coding agent
    details: Claude Code, Cursor, VS Code, Windsurf or Codex fix the issues, verify each fix at every width, and undo it if it's wrong.
    link: /guide/agents
---

<div class="demo">

![The breakhound extension scanning a small site in Chrome, then showing each issue at the width where it is worst](./demo.gif)

</div>

```bash
npx @seybel/breakhound
```

Run it in your project folder. No config: it finds your framework, your dev server and every route, and starts the server if it isn't running.

<style>
.demo img { border-radius: 12px; border: 1px solid var(--vp-c-divider); margin: 8px 0 24px; }
</style>
