import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  astroRoutes,
  Crawler,
  detectProject,
  flatNameToPattern,
  fromReactRouterPath,
  fromTanstackPath,
  fromVueRouterPath,
  globMatches,
  looksLikeProject,
  matchesPattern,
  nextAppRoutes,
  nextPagesRoutes,
  nuxtRoutes,
  parsePattern,
  remixFlatRoutes,
  routeConfigRoutes,
  routeFor,
  sourceRoutes,
  staticUrlPath,
  sveltekitRoutes,
  tanstackRoutes,
} from '../src/index';

const paths = (routes: { path: string }[]) => routes.map((r) => r.path).sort();

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'breakhound-routes-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

describe('file-based routes', () => {
  it('reads the Next.js App Router', () => {
    const routes = nextAppRoutes([
      'page.tsx',
      'layout.tsx',
      '(marketing)/pricing/page.tsx',
      'blog/[slug]/page.tsx',
      'docs/[[...path]]/page.mdx',
      'shop/[...categories]/page.jsx',
      'dashboard/@analytics/page.tsx',
      'dashboard/page.tsx',
      'feed/(..)photo/[id]/page.tsx',
      '_components/page.tsx',
      'api/route.ts',
      'blog/[slug]/page.test.tsx',
    ]);
    expect(paths(routes)).toEqual([
      '/',
      '/blog/[slug]',
      '/dashboard',
      '/docs/[[...path]]',
      '/pricing',
      '/shop/[...categories]',
    ]);
    const docs = routes.find((r) => r.path === '/docs/[[...path]]');
    expect(docs && staticUrlPath(docs)).toBe('/docs');
    expect(routes.find((r) => r.path === '/blog/[slug]')?.dynamic).toBe(true);
  });

  it('keeps a catch-all page at the root, which is usually CMS content', () => {
    const routes = nextAppRoutes(['page.tsx', '[...slug]/page.tsx', 'about/page.tsx']);
    expect(paths(routes)).toEqual(['/', '/[...slug]', '/about']);
    // A link that no other route fits is used to scan it.
    expect(routeFor('/company/history', routes)?.path).toBe('/[...slug]');
    expect(routeFor('/about', routes)?.path).toBe('/about');
    // An optional one is the home page itself when there is no other.
    expect(paths(nextAppRoutes(['[[...slug]]/page.tsx']))).toEqual(['/[[...slug]]']);
  });

  it('reads the Next.js Pages Router', () => {
    expect(
      paths(
        nextPagesRoutes([
          '_app.tsx',
          '_document.tsx',
          '404.tsx',
          'index.tsx',
          'about.tsx',
          'blog/index.tsx',
          'blog/[id].tsx',
          'api/hello.ts',
        ]),
      ),
    ).toEqual(['/', '/about', '/blog', '/blog/[id]']);
  });

  it('reads Nuxt pages, where a catch-all also matches nothing', () => {
    const routes = nuxtRoutes([
      'index.vue',
      'user-profile/[id].vue',
      'settings/index.vue',
      '(auth)/login.vue',
      'docs/[...slug].vue',
      'post-[id].vue',
      // A 404 page next to the home page: nothing of its own to scan.
      '[...slug].vue',
    ]);
    expect(paths(routes)).toEqual([
      '/',
      '/docs/[[...slug]]',
      '/login',
      '/post-[id]',
      '/settings',
      '/user-profile/[id]',
    ]);
    const post = routes.find((r) => r.path === '/post-[id]');
    expect(post && matchesPattern(post, '/post-42')).toBe(true);
    expect(post && matchesPattern(post, '/post')).toBe(false);
  });

  it('reads SvelteKit routes, including matchers and optional params', () => {
    expect(
      paths(
        sveltekitRoutes([
          '+page.svelte',
          '+layout.svelte',
          '(app)/items/[id=integer]/+page.svelte',
          '[[lang]]/about/+page.svelte',
          'api/+server.ts',
          'reset/+page@.svelte',
        ]),
      ),
    ).toEqual(['/', '/[[lang]]/about', '/items/[id]', '/reset']);
  });

  it('reads Astro pages and skips underscored files and endpoints', () => {
    expect(
      paths(
        astroRoutes(['index.astro', 'blog/[slug].astro', 'about.md', '_draft.astro', 'rss.xml.ts']),
      ),
    ).toEqual(['/', '/about', '/blog/[slug]']);
  });

  it('reads Remix and React Router flat routes', () => {
    const cases: [string, string | null][] = [
      ['_index', '/'],
      ['about', '/about'],
      ['blog.$slug', '/blog/[slug]'],
      ['_auth.login', '/login'],
      ['users_.edit', '/users/edit'],
      ['($lang).pricing', '/[[lang]]/pricing'],
      ['files.$', '/files/[[...splat]]'],
      ['sitemap[.]xml', null],
      ['$', null],
    ];
    for (const [name, expected] of cases)
      expect(flatNameToPattern(name)?.path ?? null).toBe(expected);
  });

  it('only counts route files in Remix route folders, not the modules next to them', () => {
    expect(
      paths(
        remixFlatRoutes([
          '_index.tsx',
          'blog.$slug/route.tsx',
          'blog.$slug/comments.tsx',
          'api.items/route.ts',
          'healthcheck.ts',
        ]),
      ),
    ).toEqual(['/', '/blog/[slug]']);
  });

  it('reads the TanStack route tree', () => {
    const tree = `export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/posts/$postId': typeof PostsPostIdRoute
  '/files/$': typeof FilesSplatRoute
  '/about/': typeof AboutIndexRoute
}`;
    expect(paths(tanstackRoutes(tree))).toEqual([
      '/',
      '/about',
      '/files/[[...splat]]',
      '/posts/[postId]',
    ]);
  });
});

describe('router path syntax', () => {
  it('converts Vue Router paths, including the ones Nuxt generates', () => {
    expect(fromVueRouterPath('/user-profile/:id()')?.path).toBe('/user-profile/[id]');
    expect(fromVueRouterPath('/docs/:slug(.*)*')?.path).toBe('/docs/[[...slug]]');
    expect(fromVueRouterPath('/:lang?/about')?.path).toBe('/[[lang]]/about');
    expect(fromVueRouterPath('/item/:id(\\d+)')?.path).toBe('/item/[id]');
    expect(fromVueRouterPath('/:pathMatch(.*)*')).toBeNull();
  });

  it('converts React Router and TanStack paths', () => {
    expect(fromReactRouterPath('/account/notes')?.path).toBe('/account/notes');
    expect(fromReactRouterPath('/users/:id/:tab?')?.path).toBe('/users/[id]/[[tab]]');
    expect(fromReactRouterPath('*')).toBeNull();
    expect(fromTanstackPath('/posts/{-$lang}/$id')?.path).toBe('/posts/[[lang]]/[id]');
  });

  it('parses its own display form back', () => {
    const p = parsePattern('/blog/[slug]');
    expect(p.dynamic).toBe(true);
    expect(matchesPattern(p, '/blog/hello-world')).toBe(true);
    expect(matchesPattern(p, '/blog/hello/world')).toBe(false);
    expect(matchesPattern(parsePattern('/docs/[...path]'), '/docs/a/b')).toBe(true);
  });

  it('prefers the most specific route for a URL', () => {
    const routes = [parsePattern('/blog/[slug]'), parsePattern('/blog/new')];
    expect(routeFor('/blog/new', routes)?.path).toBe('/blog/new');
    expect(routeFor('/blog/first-post', routes)?.path).toBe('/blog/[slug]');
    // Compared from the left: a fixed first segment beats an optional language prefix.
    const i18n = [parsePattern('/[[lang]]/blog/[slug]'), parsePattern('/blog/[slug]')];
    expect(routeFor('/blog/hello', i18n)?.path).toBe('/blog/[slug]');
    expect(routeFor('/fr/blog/hello', i18n)?.path).toBe('/[[lang]]/blog/[slug]');
    const docs = [parsePattern('/docs/[[...path]]'), parsePattern('/docs')];
    expect(routeFor('/docs', docs)?.path).toBe('/docs');
  });

  it('matches include and exclude globs', () => {
    expect(globMatches('/admin/**', '/admin')).toBe(true);
    expect(globMatches('/admin/**', '/admin/users/[id]')).toBe(true);
    expect(globMatches('/admin/*', '/admin/users/[id]')).toBe(false);
    expect(globMatches('/blog/*', '/blog/[slug]')).toBe(true);
    expect(globMatches('/**', '/')).toBe(true);
  });
});

describe('routes defined in code', () => {
  it('follows imports from index.html and ignores files nothing imports', () => {
    const root = project({
      'index.html': '<script type="module" src="/src/main.tsx"></script>',
      'src/main.tsx': "import App from './App';\ncreateRoot(el).render(<App />);",
      'src/App.tsx': `import { Routes, Route } from 'react-router-dom';
import Settings from '@/pages/Settings';
export default () => (
  <Routes>
    <Route index element={<Home />} />
    <Route path="about" element={<About />} />
    <Route element={<Protected />}>
      <Route path="account" element={<Dashboard />}>
        <Route index element={<List />} />
        <Route path="notes" element={<Notes />} />
      </Route>
    </Route>
    <Route path="users/:id" element={<User />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);`,
      'src/pages/Settings.tsx': 'export default function Settings() { return null; }',
      'src/old-router.tsx': `createBrowserRouter([{ path: '/legacy', element: <Old /> }]);`,
    });
    expect(paths(sourceRoutes(root, 'react').routes)).toEqual([
      '/',
      '/about',
      '/account',
      '/account/notes',
      '/users/[id]',
    ]);
  });

  it('reads route objects, nested children and Vue redirects', () => {
    const root = project({
      'src/main.ts': "import router from './router';\ncreateApp(App).use(router);",
      'src/router/index.ts': `export default createRouter({ routes: [
  { path: '/', component: Home },
  { path: '/old', redirect: '/' },
  { path: '/settings', component: () => import('../views/Settings.vue'), children: [
    { path: 'profile', component: Profile },
  ] },
  { path: '/:pathMatch(.*)*', component: NotFound },
] });`,
    });
    expect(paths(sourceRoutes(root, 'vue').routes)).toEqual([
      '/',
      '/settings',
      '/settings/profile',
    ]);
  });

  it('reads Angular routes, including lazily loaded child routes under their path', () => {
    const root = project({
      'src/index.html': '<app-root></app-root>',
      'src/main.ts':
        "import { appConfig } from './app/app.config';\nbootstrapApplication(AppComponent, appConfig);",
      'src/app/app.config.ts':
        "import { routes } from './app.routes';\nexport const appConfig = { providers: [provideRouter(routes)] };",
      'src/app/app.routes.ts': `export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'products/:id', loadComponent: () => import('./product/product.component').then((m) => m.ProductComponent) },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
  { path: 'old-home', redirectTo: '', pathMatch: 'full' },
  { path: '**', component: NotFoundComponent },
];`,
      'src/app/product/product.component.ts': 'export class ProductComponent {}',
      'src/app/admin/admin.routes.ts': `export const ADMIN_ROUTES: Routes = [
  { path: '', component: AdminHomeComponent },
  { path: 'users', component: UsersComponent, children: [{ path: ':id', component: UserComponent }] },
];`,
    });
    expect(paths(sourceRoutes(root, 'angular').routes)).toEqual([
      '/',
      '/admin',
      '/admin/users',
      '/admin/users/[id]',
      '/products/[id]',
    ]);
  });

  it('reads React Router 7 route config', () => {
    const root = project({
      'app/routes.ts': `import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';
export default [
  index('routes/home.tsx'),
  route('about', 'routes/about.tsx'),
  layout('routes/auth/layout.tsx', [route('login', 'routes/auth/login.tsx')]),
  ...prefix('concerts', [index('routes/concerts/home.tsx'), route(':city', 'routes/concerts/city.tsx')]),
] satisfies RouteConfig;`,
    });
    expect(paths(routeConfigRoutes(root) ?? [])).toEqual([
      '/',
      '/about',
      '/concerts',
      '/concerts/[city]',
      '/login',
    ]);
  });
});

describe('project detection', () => {
  it('finds the framework, package manager, dev script and ports', () => {
    const root = project({
      'package.json': JSON.stringify({
        scripts: { dev: 'vite --port 4100', start: 'node server.js' },
        dependencies: { react: '*', 'react-router-dom': '*' },
        devDependencies: { vite: '*' },
      }),
      'yarn.lock': '',
    });
    const p = detectProject(root);
    expect(p?.framework.id).toBe('react');
    expect(p?.packageManager).toBe('yarn');
    expect(p?.devScript?.name).toBe('dev');
    expect(p?.ports.slice(0, 2)).toEqual([4100, 5173]);
  });

  it('does not treat a production start script as a dev server', () => {
    const root = project({
      'package.json': JSON.stringify({
        scripts: { start: 'next start' },
        dependencies: { next: '*' },
      }),
    });
    expect(detectProject(root)?.devScript).toBeNull();
  });

  it("doesn't take another app on a guessed port for a project it can't fingerprint", () => {
    const root = project({
      'package.json': JSON.stringify({ scripts: { dev: 'node server.js --port 4100' } }),
    });
    const p = detectProject(root);
    if (!p) throw new Error('no project');
    expect(p.configuredPorts).toEqual([4100]);
    const plain = { status: 200, headers: {}, html: '<!doctype html><html><body>Hi</body></html>' };
    const next = {
      status: 200,
      headers: { 'x-powered-by': 'Next.js' },
      html: '<!doctype html><html><script src="/_next/static/chunks/main.js"></script></html>',
    };
    // On the port it sets itself, a plain page is the project; on a common port it could be anything.
    expect(looksLikeProject(p, plain, true)).toBe(true);
    expect(looksLikeProject(p, plain, false)).toBe(false);
    // Another framework's app is never it, even on its own port.
    expect(looksLikeProject(p, next, true)).toBe(false);
  });
});

describe('crawling', () => {
  it('takes every top-level page but only a few siblings deeper down', () => {
    const crawler = new Crawler(50);
    crawler.claim('/');
    const picked = crawler.add([
      '/',
      '/about',
      '/pricing/',
      '/blog/a',
      '/blog/b',
      '/blog/c',
      '/blog/d',
      '/logout',
      '/files/report.pdf',
      '/api/items',
    ]);
    expect(picked).toEqual(['/about', '/pricing', '/blog/a', '/blog/b', '/blog/c']);
  });

  it('only follows links that include and exclude allow', () => {
    const crawler = new Crawler(50, (path) => !path.startsWith('/admin'));
    expect(crawler.add(['/admin', '/admin/users', '/docs'])).toEqual(['/docs']);
  });
});
