# Configuration

Optional. `npx @seybel/breakhound init` creates one. If breakhound is in your dev dependencies you get `breakhound.config.ts` (or `.mjs` without TypeScript), fully typed:

```ts
import { defineConfig } from '@seybel/breakhound';

export default defineConfig({
  exclude: ['/admin/**'],                       // or include: ['/blog/**']
  samples: { '/products/[id]': '/products/42' },
  widths: { min: 320, max: 1920 },
  ignore: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }],
  detectors: { 'tiny-text': false, 'edge-gutter': 'info' },
  failOn: 'error',
});
```

Running breakhound through `npx` without installing it, you get `breakhound.config.json` instead. A TypeScript file importing a package that isn't installed would break your project's own type check (and builds that run it, like `next build`). The JSON file points at breakhound's schema, so your editor still suggests and explains every option:

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@seybel/breakhound/dist/schema.json",
  "exclude": ["/admin/**"]
}
```

`.js`, `.cjs` and `.mts` configs work too. The types ship for both `import` and `require`.

| Option | What it does |
|---|---|
| `baseUrl` | Scan this server instead of finding or starting the dev server |
| `routes` | Scan exactly these routes instead of discovering them |
| `include`, `exclude` | Route globs: `*` is one segment, `**` any number |
| `samples` | A real URL for a dynamic route |
| `params` | Real values for dynamic route parameters by name, for every route that uses them |
| `maxRoutes` | Most routes per run (default 100) |
| `server` | How to start the app: `{ command: 'npm run preview', port: 4173, timeout: 120 }` |
| `widths` | `{ min, max, step }` in CSS pixels |
| `ignore`, `detectors` | Leave elements out, turn checks off or change their severity |
| `failOn` | Exit 1 at `error`, `warning`, `info` or `none` |
| `vision` | `true` to add a vision model's opinion, or `{ model, provider, widths }` |
| `fix` | The model `breakhound fix` uses: `{ provider: 'ollama', model: 'qwen2.5-coder' }` |
| `browsers` | Engines to check in: `["chromium", "webkit", "firefox"]` (default Chromium only) |
| `states` | Most menus, dialogs and expandable sections to open per page (default 5), or `false` |
| `concurrency` | Browser tabs to use at once (default half your CPU cores, up to 4) |
| `memoryLimit` | Most memory the dev server and browser may use together, e.g. `"6GB"`, `"50%"` or `"off"` (default 60% of your memory) |

You can also mark elements in your markup:

```html
<div data-breakhound-ignore>...</div>                      <!-- every check -->
<div data-breakhound-ignore="overlap small-tap-target">...</div>
```
