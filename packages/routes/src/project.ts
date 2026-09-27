import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FrameworkId =
  | 'next'
  | 'nuxt'
  | 'sveltekit'
  | 'astro'
  | 'remix'
  | 'react-router'
  | 'tanstack'
  | 'angular'
  | 'gatsby'
  | 'react'
  | 'vue'
  | 'vite'
  | 'unknown';

export interface Framework {
  id: FrameworkId;
  /** Display name, e.g. "Next.js". */
  name: string;
  /** How the router is defined: from files, or in code (read at runtime). */
  routing: 'files' | 'code' | 'none';
}

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface Project {
  root: string;
  framework: Framework;
  packageManager: PackageManager;
  /** The package.json script that starts the dev server, and what it runs. */
  devScript: { name: string; command: string } | null;
  /** Ports to look for a running dev server on, most likely first. */
  ports: number[];
  /** Where the app is mounted, e.g. "/docs" for Next's basePath; "" at the root. */
  basePath: string;
}

const FRAMEWORKS: Record<FrameworkId, Omit<Framework, 'id'>> = {
  next: { name: 'Next.js', routing: 'files' },
  nuxt: { name: 'Nuxt', routing: 'code' },
  sveltekit: { name: 'SvelteKit', routing: 'files' },
  astro: { name: 'Astro', routing: 'files' },
  remix: { name: 'Remix', routing: 'code' },
  'react-router': { name: 'React Router', routing: 'code' },
  tanstack: { name: 'TanStack Router', routing: 'files' },
  angular: { name: 'Angular', routing: 'none' },
  gatsby: { name: 'Gatsby', routing: 'none' },
  react: { name: 'React', routing: 'code' },
  vue: { name: 'Vue', routing: 'code' },
  vite: { name: 'Vite', routing: 'none' },
  unknown: { name: 'your app', routing: 'none' },
};

const DEFAULT_PORT: Partial<Record<FrameworkId, number>> = {
  next: 3000,
  nuxt: 3000,
  sveltekit: 5173,
  astro: 4321,
  remix: 5173,
  'react-router': 5173,
  tanstack: 3000,
  angular: 4200,
  gatsby: 8000,
  react: 5173,
  vue: 5173,
  vite: 5173,
};

const COMMON_PORTS = [3000, 5173, 4321, 8080, 4200, 3001, 5174, 8000, 4173, 3002];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function detectFramework(deps: Record<string, string>): Framework {
  const has = (name: string) => name in deps;
  let id: FrameworkId = 'unknown';
  if (has('next')) id = 'next';
  else if (has('nuxt') || has('nuxt3')) id = 'nuxt';
  else if (has('@sveltejs/kit')) id = 'sveltekit';
  else if (has('astro')) id = 'astro';
  else if (has('@react-router/dev')) id = 'react-router';
  else if (has('@remix-run/dev') || has('@remix-run/react')) id = 'remix';
  else if (
    has('@tanstack/react-router') ||
    has('@tanstack/react-start') ||
    has('@tanstack/vue-router')
  )
    id = 'tanstack';
  else if (has('@angular/core')) id = 'angular';
  else if (has('gatsby')) id = 'gatsby';
  else if (has('react-router-dom') || has('react-router') || has('@reach/router')) id = 'react';
  else if (has('vue-router') || has('vue')) id = 'vue';
  else if (has('react-scripts') || has('react')) id = 'react';
  else if (has('vite')) id = 'vite';
  return { id, ...FRAMEWORKS[id] };
}

function detectPackageManager(root: string, pkg: PackageJson | null): PackageManager {
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'yarn' || declared === 'pnpm' || declared === 'bun' || declared === 'npm')
    return declared;
  // Lockfiles can live at the top of a monorepo.
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
    if (dirname(dir) === dir) return 'npm';
  }
}

/** Dev tools that start a server for the app, as opposed to a production `start`. */
const DEV_SERVER =
  /\b(vite|next dev|nuxt dev|nuxi dev|astro dev|remix|react-router dev|react-scripts start|ng serve|vue-cli-service serve|webpack(-dev-server| serve)|parcel|gatsby develop|rsbuild dev|rspack serve)\b/;

function pickDevScript(scripts: Record<string, string>): { name: string; command: string } | null {
  for (const name of ['dev', 'develop', 'serve', 'start', 'dev:web', 'dev:app']) {
    const command = scripts[name];
    if (!command) continue;
    // `start` often means the production server, which needs a build first.
    if (name === 'start' && !DEV_SERVER.test(command)) continue;
    return { name, command };
  }
  return null;
}

/** Ports set explicitly in the dev script or in the framework's config file. */
function configuredPorts(root: string, script: string | undefined): number[] {
  const ports: number[] = [];
  const fromScript = script?.match(/(?:--port|-p)[ =](\d{2,5})|\bPORT=(\d{2,5})/);
  const scriptPort = fromScript?.[1] ?? fromScript?.[2];
  if (scriptPort) ports.push(Number(scriptPort));
  const configs = [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mts',
    'vite.config.mjs',
    'nuxt.config.ts',
    'nuxt.config.js',
    'astro.config.mjs',
    'astro.config.ts',
    'svelte.config.js',
    'angular.json',
  ];
  for (const name of configs) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const m =
      text.match(/(?:server|devServer)\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/) ??
      text.match(/"port"\s*:\s*(\d{2,5})/);
    if (m?.[1]) ports.push(Number(m[1]));
  }
  return ports;
}

const BASE_PATH: [string[], RegExp][] = [
  [['next.config.js', 'next.config.mjs', 'next.config.ts'], /\bbasePath\s*:\s*['"`]([^'"`]+)['"`]/],
  [['nuxt.config.ts', 'nuxt.config.js'], /\bbaseURL\s*:\s*['"`]([^'"`]+)['"`]/],
  [
    ['svelte.config.js', 'svelte.config.ts'],
    /\bpaths\s*:\s*\{[^}]*?\bbase\s*:\s*['"`]([^'"`]+)['"`]/,
  ],
  [['astro.config.mjs', 'astro.config.ts'], /\bbase\s*:\s*['"`](\/[^'"`]*)['"`]/],
  [
    ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'],
    /\bbase\s*:\s*['"`](\/[^'"`]*)['"`]/,
  ],
];

/** A base path set in the framework config, like Next's basePath or Vite's base. */
function detectBasePath(root: string): string {
  for (const [files, pattern] of BASE_PATH) {
    for (const name of files) {
      const file = join(root, name);
      if (!existsSync(file)) continue;
      const found = readFileSync(file, 'utf8').match(pattern)?.[1];
      if (found) return normalizeBasePath(found);
    }
  }
  return '';
}

export function normalizeBasePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Finds the app in `cwd`: its framework, how to start it, and where it likely runs. */
export function detectProject(cwd: string): Project | null {
  const pkg = readJson<PackageJson>(join(cwd, 'package.json'));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFramework(deps);
  const devScript = pickDevScript(pkg.scripts ?? {});
  const defaultPort = DEFAULT_PORT[framework.id];
  const ports = [
    ...configuredPorts(cwd, devScript?.command),
    ...(defaultPort ? [defaultPort] : []),
    ...COMMON_PORTS,
  ];
  return {
    root: cwd,
    framework,
    packageManager: detectPackageManager(cwd, pkg),
    devScript,
    ports: [...new Set(ports)],
    basePath: detectBasePath(cwd),
  };
}
