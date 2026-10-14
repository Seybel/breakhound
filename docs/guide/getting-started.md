# Getting started

breakhound finds your framework and dev server (and starts it if needed), discovers every route, sweeps each page from 320px to 1920px in a real browser, finds the exact pixel where things go wrong, and tells you why.

## Quick start

In your project folder:

```bash
npx @seybel/breakhound
```

That's it: no config. npx runs it without installing anything. To type `breakhound` directly instead, install it globally:

```bash
npm i -g @seybel/breakhound
```

Or add it to your project with `npm i -D @seybel/breakhound`, so everyone gets the same version, and run it as `npx breakhound` or from an npm script.

If your dev server is already running it's used, otherwise breakhound starts it with your `dev` script and stops it when done. Chromium is downloaded automatically the first time (about 150 MB).

Other ways to run it:

```bash
npx @seybel/breakhound /pricing /blog          # only these routes
npx @seybel/breakhound http://localhost:3000   # just this one page
npx @seybel/breakhound --url https://staging.example.com   # every route, on another server
```

## Finding routes

| Project | Where routes come from |
|---|---|
| Next.js (App and Pages Router) | `app/` and `pages/`, skipping route groups, parallel slots, private folders and API routes |
| Nuxt | the live Vue router, so module and custom routes count too (falls back to `pages/`) |
| SvelteKit | `src/routes` |
| Astro | `src/pages` |
| Remix, React Router 7 | the route manifest, `app/routes.ts` and `app/routes/` |
| TanStack Router | `routeTree.gen.ts` and the live router |
| React Router (code-defined) | the live route tree, including `<Routes>` nested inside pages; falls back to reading your router code |
| Vue Router (code-defined) | the live router; falls back to reading your router code |
| Angular | your route definitions, from `src/main.ts` on, with lazily loaded `loadChildren` routes under their path |
| Anything else | links followed from the home page (up to 50 pages, a few per section) |

**Dynamic routes** like `/blog/[slug]` are scanned once, using a real link found on your pages (routes that share a template share a layout). If no page links to one, it's listed with a hint, and you can give it a URL:

```ts
samples: { '/products/[id]': '/products/42' }
```

**Pages behind a login** are spotted (they redirect to a sign-in page) and listed instead of scanning the login page over and over. Sign in once:

```bash
npx @seybel/breakhound login
```

A browser window opens; log in as you normally would, then press Enter. The session is saved to `.breakhound/auth.json`, which is never committed (see [Reports](/guide/checks#reports)), and used by later scans. breakhound never sees your password.

Links that would log you out, delete something, or download a file are never followed.

## Next

- [Your first scan](/guide/first-scan): a whole session, from reading the results to fixing, checking and undoing.
- [Recipes](/guide/recipes): only mobile widths, staging sites, pages behind a login, CI, and more.
