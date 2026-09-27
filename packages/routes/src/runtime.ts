/**
 * Code that runs inside the page to read routes from the live router, the
 * same place framework devtools read them from. Everything here must be
 * self-contained: the functions are serialised and evaluated in the browser.
 */

export type RuntimeRouter = 'vue' | 'react-router' | 'remix' | 'tanstack';

export interface RuntimeRoutes {
  router: RuntimeRouter | null;
  /** Paths in the router's own syntax. */
  paths: string[];
}

export function readRuntimeRoutes(): RuntimeRoutes {
  // biome-ignore lint/suspicious/noExplicitAny: framework internals are untyped.
  type Any = any;
  const w = window as Any;
  const paths = new Set<string>();
  // A parent like "account/*" hands "account" to its children.
  const join = (base: string, path: string) =>
    path.startsWith('/') ? path : `${base.replace(/\/?\*$/, '').replace(/\/+$/, '')}/${path}`;

  // Remix and React Router 7 framework mode ship a manifest of every route.
  const manifest = w.__reactRouterManifest?.routes ?? w.__remixManifest?.routes;
  if (manifest && typeof manifest === 'object') {
    const fullPath = (id: string, depth = 0): string => {
      const r = manifest[id];
      if (!r || depth > 50) return '';
      const parent = r.parentId ? fullPath(r.parentId, depth + 1) : '';
      return r.path ? join(parent, r.path) : parent;
    };
    for (const id of Object.keys(manifest)) {
      const r = manifest[id];
      if (id === 'root' || (!r.path && !r.index)) continue;
      paths.add(fullPath(id) || '/');
    }
    if (paths.size) return { router: 'remix', paths: [...paths] };
  }

  // Vue 3 (and Nuxt): the app instance hangs off its mount element.
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const app = (el as Any).__vue_app__;
    const router = app?.config?.globalProperties?.$router;
    if (router?.getRoutes) {
      for (const r of router.getRoutes())
        if (!r.redirect && typeof r.path === 'string') paths.add(r.path);
      return { router: 'vue', paths: [...paths] };
    }
    // Vue 2 keeps it on the root instance.
    const vm = (el as Any).__vue__?.$root;
    if (vm?.$router) {
      const records = vm.$router.getRoutes?.() ?? [];
      for (const r of records) if (!r.redirect && typeof r.path === 'string') paths.add(r.path);
      if (paths.size) return { router: 'vue', paths: [...paths] };
    }
  }

  // React: walk the fiber tree from each root.
  const roots: Any[] = [];
  for (const el of all) {
    for (const key of Object.keys(el)) {
      // The container keeps the fiber from the first render; the live tree hangs off its root.
      if (key.startsWith('__reactContainer$')) {
        const fiber = (el as Any)[key];
        roots.push(fiber?.stateNode?.current ?? fiber);
      }
    }
    const legacy = (el as Any)._reactRootContainer;
    if (legacy) roots.push(legacy._internalRoot?.current ?? legacy.current);
  }
  if (!roots.length) return { router: null, paths: [] };

  let kind: RuntimeRouter | null = null;
  // An index route under "settings/*" is the page at /settings.
  const indexPath = (base: string) => base.replace(/\/?\*$/, '') || '/';
  const isRouteElement = (e: Any) =>
    e &&
    typeof e === 'object' &&
    e.props &&
    (typeof e.props.path === 'string' || e.props.index === true) &&
    ('element' in e.props ||
      'Component' in e.props ||
      'component' in e.props ||
      'children' in e.props ||
      'lazy' in e.props);
  const toList = (c: Any): Any[] => (Array.isArray(c) ? c.flat(Infinity) : c ? [c] : []);

  const walkElements = (children: Any, base: string) => {
    for (const e of toList(children)) {
      if (!isRouteElement(e)) {
        // Fragments and conditionals can wrap routes.
        if (e?.props?.children && !e.props.path) walkElements(e.props.children, base);
        continue;
      }
      const full = typeof e.props.path === 'string' ? join(base, e.props.path) : base;
      if (typeof e.props.path === 'string') paths.add(full);
      else if (e.props.index) paths.add(indexPath(base));
      walkElements(e.props.children, full);
    }
  };
  const walkObjects = (routes: Any[], base: string, depth = 0) => {
    if (!Array.isArray(routes) || depth > 30) return;
    for (const r of routes) {
      if (!r || typeof r !== 'object') continue;
      const full = typeof r.path === 'string' ? join(base, r.path) : base;
      if (typeof r.path === 'string') paths.add(full);
      else if (r.index) paths.add(indexPath(base));
      walkObjects(r.children, full, depth + 1);
    }
  };
  /** The route a nested <Routes> is rendered under, from React Router's route context. */
  const baseOf = (fiber: Any): string => {
    for (let f = fiber.return; f; f = f.return) {
      const matches = f.memoizedProps?.value?.matches ?? f.memoizedProps?.routeContext?.matches;
      if (Array.isArray(matches) && matches.length) {
        let base = '';
        for (const m of matches)
          if (typeof m.route?.path === 'string') base = join(base, m.route.path);
        return base;
      }
    }
    return '';
  };

  let visited = 0;
  for (const root of roots) {
    const stack: Any[] = [root];
    while (stack.length && visited < 200_000) {
      const fiber = stack.pop();
      visited++;
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object') {
        const router = props.router;
        if (router?.routesByPath && typeof router.routesByPath === 'object') {
          kind = 'tanstack';
          for (const p of Object.keys(router.routesByPath)) paths.add(p);
        } else if (Array.isArray(router?.routes)) {
          kind = 'react-router';
          walkObjects(router.routes, '');
        } else if (toList(props.children).some(isRouteElement)) {
          kind = 'react-router';
          walkElements(props.children, baseOf(fiber));
        }
        const matches = props.routeContext?.matches ?? props.value?.matches;
        if (Array.isArray(matches)) {
          // useRoutes(): only the matched branch is reachable, but each match lists its children.
          let base = '';
          for (const m of matches) {
            if (typeof m?.route?.path === 'string') base = join(base, m.route.path);
            if (Array.isArray(m?.route?.children)) {
              kind ??= 'react-router';
              walkObjects(m.route.children, base);
            }
          }
        }
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  }
  return { router: kind, paths: [...paths] };
}

/**
 * Same-origin links on the page, without query, for sampling dynamic routes
 * and crawling. Links into a hash router (`#/about`) also come back whole, as
 * `/#/about`, for apps that route that way.
 */
export function readLinks(): string[] {
  const out = new Set<string>();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = (a as HTMLAnchorElement).href;
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      continue;
    }
    if (url.origin !== location.origin) continue;
    if ((a as HTMLAnchorElement).hasAttribute('download')) continue;
    out.add(url.pathname);
    if (url.hash.startsWith('#/')) out.add(`${url.pathname}${url.hash.split('?')[0]}`);
  }
  return [...out];
}
