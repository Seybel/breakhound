import { routeConfigRoutes, sourceRoutes } from './ast';
import type { RouteSource } from './crawl';
import { fileRoutes } from './files';
import type { FrameworkId, Project } from './project';

export {
  Crawler,
  isCrawlable,
  type RouteSource,
  routeFor,
  runtimeRoutes,
} from './crawl';

/** Frameworks whose route list lives entirely in files; no need to ask the running app. */
const FILES_ONLY: FrameworkId[] = ['next', 'sveltekit', 'astro'];

/** Whether it's worth reading the live router before scanning. */
export function wantsRuntimeRoutes(framework: FrameworkId): boolean {
  return !FILES_ONLY.includes(framework);
}

/** Routes read from the project without running it: route files, route config, or router code. */
export function staticRoutes(project: Project): RouteSource | null {
  const { root, framework } = project;
  if (framework.id === 'react-router' || framework.id === 'remix') {
    const config = routeConfigRoutes(root);
    if (config?.length) return { from: 'app/routes.ts', routes: config };
  }
  const files = fileRoutes(root, framework.id);
  if (files?.routes.length) return files;
  if (framework.id === 'react' || framework.id === 'vue' || framework.id === 'angular') {
    const code = sourceRoutes(root, framework.id);
    if (code.routes.length) return { from: 'your router code', routes: code.routes };
  }
  return null;
}
