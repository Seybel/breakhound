# Recipes

Short answers for common jobs. Every command runs from your project folder. Settings that you'd use every time can go in a [config file](/reference/config) instead of flags.

## Choosing what to scan

**Only phones, or only some widths**

```bash
npx @seybel/breakhound --max 767             # 320 to 767px
npx @seybel/breakhound --min 768 --max 1279  # tablets and small laptops
```

A smaller range scans faster. In a config file: `widths: { min: 320, max: 767 }`.

**One page, or a few**

```bash
npx @seybel/breakhound /pricing /checkout
```

**A whole section, or everything except one**

```bash
npx @seybel/breakhound --include '/blog/**'
npx @seybel/breakhound --exclude '/admin/**' --exclude '/internal/**'
```

`*` matches one part of a path, `**` any number. Quote them so your shell leaves them alone.

**A page that isn't part of your app**

```bash
npx @seybel/breakhound https://example.com/pricing
npx @seybel/breakhound ./design/mockup.html
```

**A staging or preview site, every route**

```bash
npx @seybel/breakhound --url https://staging.example.com
```

breakhound still finds the routes from your project, then scans them on that server.

**A dynamic route no page links to**

Routes like `/products/[id]` are scanned once, with a real link found on your pages. If nothing links to one, give it an address in your config:

```ts
samples: { '/products/[id]': '/products/42' }
```

## Logins, servers and big apps

**Pages behind a login**

```bash
npx @seybel/breakhound login
```

A browser opens: log in, then press Enter in the terminal. Later scans reuse the session (saved in `.breakhound/auth.json`, never committed). Run it again when the session expires.

**Your app doesn't start with `npm run dev`, or uses another port**

Start it yourself and pass the address:

```bash
npx @seybel/breakhound --url http://localhost:4000
```

Or tell breakhound how to start it, in your config:

```ts
server: { command: 'npm run preview', port: 4173 }
```

**A monorepo**

Run breakhound in the app's own folder (where its `package.json` and `dev` script are), not at the repo root.

**A big app, or a smaller machine**

```bash
npx @seybel/breakhound --max-routes 20 --concurrency 1
npx @seybel/breakhound --memory-limit 4GB
```

breakhound stops what it started before the dev server and browser use more memory than the limit (60% of your memory by default), and tells you what used it.

**Faster scans while you work**

```bash
npx @seybel/breakhound /pricing --max 767 --no-states --no-screenshots
```

`--no-states` skips opening menus and dialogs; `--no-screenshots` skips the pictures in the report.

## What gets reported

**Ignore an element on purpose**

```html
<div class="map" data-breakhound-ignore>...</div>
<div class="chat-widget" data-breakhound-ignore="overlap">...</div>
```

Or from your config, without touching the markup:

```ts
ignore: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }]
```

**Turn a check off, or make it less serious**

```ts
detectors: { 'tiny-text': false, 'edge-gutter': 'info' }
```

The check names are listed in [What it checks](/guide/checks).

**Safari and Firefox too**

```bash
npx @seybel/breakhound --browsers chromium,webkit,firefox
```

Issues that show up in only some of them say so, like `(only in WebKit)`.

**Open the report when it's done**

```bash
npx @seybel/breakhound --open
```

## In CI

**Fail the build on warnings too**

```bash
npx @seybel/breakhound --fail-on warning
```

Exit codes: `0` clean, `1` issues at or above `--fail-on` (errors by default), `2` a page couldn't be checked.

**GitHub Actions**

```yaml
- uses: Seybel/breakhound@v1
  with:
    fail-on: error
```

See [CI](/guide/ci) for scanning preview deployments and other CI systems.

## Run it as `breakhound`

```bash
npm i -g @seybel/breakhound   # then: breakhound, breakhound verify, ...
```

Or keep it in the project, so everyone has the same version, and add a script:

```bash
npm i -D @seybel/breakhound
```

```json
{
  "scripts": {
    "responsive": "breakhound"
  }
}
```

Then `npm run responsive`, or `npx breakhound` in that project.
