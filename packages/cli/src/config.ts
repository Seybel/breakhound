import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_IDS } from '@breakhound/analyzers/types';
import type { DetectorId, IgnoreRule, Severity } from '@breakhound/engine/types';

export interface BreakhoundConfig {
  /** Where your app is running, e.g. http://localhost:3000. */
  baseUrl?: string;
  /** Pages to scan: paths (joined to baseUrl) or full URLs. Leave it out to find every route automatically. */
  routes?: string[];
  /** Only scan routes matching these globs, e.g. ['/blog/**']. `*` is one segment, `**` any number. */
  include?: string[];
  /** Skip routes matching these globs, e.g. ['/admin/**']. */
  exclude?: string[];
  /** A real URL for each dynamic route, e.g. { '/products/[id]': '/products/42' }. */
  samples?: Record<string, string>;
  /** Most routes to scan in one run (default 100). */
  maxRoutes?: number;
  /** How to start the app when it isn't running, if not with its "dev" script. */
  server?: { command?: string; port?: number; timeout?: number };
  /** Viewport widths to sweep, in CSS pixels. */
  widths?: { min?: number; max?: number; step?: number };
  /** Turn a check off with `false`, or change how serious it is. */
  detectors?: Partial<Record<DetectorId, boolean | Severity>>;
  /** Elements to leave out: a CSS selector, or a selector limited to some checks. */
  ignore?: (string | IgnoreRule)[];
  /** Exit with code 1 when an issue at this level (or worse) is found. */
  failOn?: Severity | 'none';
  /** Where reports are written. */
  outDir?: string;
  /** Take a screenshot of every issue. */
  screenshots?: boolean;
  /** Also write report.pdf. */
  pdf?: boolean;
  /** Browser tabs to use at once (default: half your CPU cores, up to 4). */
  concurrency?: number;
  /** How long to wait for the page to settle. */
  settle?: { networkIdleMs?: number; maxSettleMs?: number };
}

export function defineConfig(config: BreakhoundConfig): BreakhoundConfig {
  return config;
}

const CONFIG_FILES = [
  'breakhound.config.ts',
  'breakhound.config.mts',
  'breakhound.config.js',
  'breakhound.config.mjs',
  'breakhound.config.cjs',
  'breakhound.config.json',
];

export interface LoadedConfig {
  config: BreakhoundConfig;
  file: string | null;
  /** Problems worth telling the user about that don't stop the scan (typos, unknown checks). */
  warnings: string[];
}

/**
 * `import { defineConfig } from 'breakhound'` has to work even when breakhound
 * runs through npx and isn't installed in the project, so the import is
 * pointed at this running copy.
 */
function selfModule(): string {
  for (const candidate of ['./lib.ts', './index.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return 'breakhound';
}

export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const file = explicit
    ? resolve(cwd, explicit)
    : CONFIG_FILES.map((f) => join(cwd, f)).find((f) => existsSync(f));
  if (!file) return { config: {}, file: null, warnings: [] };
  if (!existsSync(file)) throw new Error(`Config file not found: ${file}`);

  let config: unknown;
  if (file.endsWith('.json')) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    const { createJiti } = await import('jiti');
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { breakhound: selfModule() },
    });
    const mod = await jiti.import<{ default?: BreakhoundConfig } | BreakhoundConfig>(file);
    config = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${file} must export a config object (export default defineConfig({ ... }))`);
  }
  const loaded = config as BreakhoundConfig;
  // "localhost:3000" is what people type; it means http.
  if (
    typeof loaded.baseUrl === 'string' &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(loaded.baseUrl)
  ) {
    loaded.baseUrl = `http://${loaded.baseUrl}`;
  }
  return { config: loaded, file, warnings: validateConfig(loaded) };
}

const KNOWN_KEYS = new Set([
  'baseUrl',
  'routes',
  'include',
  'exclude',
  'samples',
  'maxRoutes',
  'server',
  'widths',
  'detectors',
  'ignore',
  'failOn',
  'outDir',
  'screenshots',
  'pdf',
  'concurrency',
  'settle',
]);

/** Throws on values that would break the scan; returns warnings for likely typos. */
export function validateConfig(config: BreakhoundConfig): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown config option "${key}" was ignored.`);
  }
  if (config.baseUrl !== undefined && !/^https?:\/\/[^/]/i.test(String(config.baseUrl))) {
    throw new Error(
      `baseUrl must be a full URL like http://localhost:3000 (got "${config.baseUrl}")`,
    );
  }
  if (config.routes !== undefined) {
    if (!Array.isArray(config.routes) || config.routes.some((r) => typeof r !== 'string')) {
      throw new Error('routes must be a list of paths or URLs, like ["/", "/pricing"]');
    }
  }
  for (const key of ['include', 'exclude'] as const) {
    const v = config[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((g) => typeof g !== 'string'))) {
      throw new Error(`${key} must be a list of route globs, like ["/admin/**"]`);
    }
  }
  if (config.samples !== undefined) {
    const ok =
      config.samples &&
      typeof config.samples === 'object' &&
      !Array.isArray(config.samples) &&
      Object.values(config.samples).every((v) => typeof v === 'string');
    if (!ok) {
      throw new Error(
        `samples must map a dynamic route to a real one, like { "/products/[id]": "/products/42" }`,
      );
    }
  }
  if (
    config.maxRoutes !== undefined &&
    (!Number.isInteger(config.maxRoutes) || config.maxRoutes <= 0)
  ) {
    throw new Error('maxRoutes must be a positive whole number');
  }
  if (config.server !== undefined) {
    const { command, port, timeout } = config.server ?? {};
    if (command !== undefined && typeof command !== 'string')
      throw new Error('server.command must be a string');
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
      throw new Error('server.port must be a port number');
    }
    if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0)) {
      throw new Error('server.timeout must be a number of seconds');
    }
  }
  for (const key of ['min', 'max', 'step'] as const) {
    const v = config.widths?.[key];
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
      throw new Error(`widths.${key} must be a positive whole number of pixels`);
    }
  }
  for (const [id, value] of Object.entries(config.detectors ?? {})) {
    if (!DETECTOR_IDS.includes(id as DetectorId)) {
      warnings.push(
        `Unknown check "${id}" in detectors. Known checks: ${DETECTOR_IDS.join(', ')}.`,
      );
    } else if (![true, false, 'error', 'warning', 'info'].includes(value as string | boolean)) {
      warnings.push(`detectors["${id}"] should be true, false, "error", "warning" or "info".`);
    }
  }
  return warnings;
}

export function normalizeIgnore(ignore: BreakhoundConfig['ignore']): IgnoreRule[] {
  return (ignore ?? []).map((rule) => (typeof rule === 'string' ? { selector: rule } : rule));
}
