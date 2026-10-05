import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_IDS } from '@breakhound/analyzers/types';
import { BROWSER_NAMES, type DetectorId, type IgnoreRule } from '@breakhound/engine/types';
import type { BreakhoundConfig } from './define';
import { parseMemoryLimit } from './guard';

export { type BreakhoundConfig, defineConfig } from './define';

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

export const KNOWN_KEYS = new Set([
  '$schema',
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
  'states',
  'pdf',
  'browsers',
  'concurrency',
  'memoryLimit',
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
    config.states !== undefined &&
    typeof config.states !== 'boolean' &&
    !(Number.isInteger(config.states) && config.states >= 0)
  ) {
    throw new Error('states must be true, false, or the most menus and dialogs to open per page');
  }
  if (config.browsers !== undefined) {
    const list = config.browsers;
    const valid =
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((b) => (BROWSER_NAMES as readonly string[]).includes(b)) &&
      new Set(list).size === list.length;
    if (!valid) {
      throw new Error(
        `browsers must be a list of ${BROWSER_NAMES.join(', ')}, like ["chromium", "webkit"]`,
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
  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) || config.concurrency <= 0)
  ) {
    throw new Error('concurrency must be a positive whole number');
  }
  if (config.memoryLimit !== undefined) {
    if (config.memoryLimit !== false && typeof config.memoryLimit !== 'string')
      throw new Error('memoryLimit must be a size like "6GB", a share like "50%", or "off"');
    parseMemoryLimit(config.memoryLimit);
  }
  for (const key of ['networkIdleMs', 'maxSettleMs'] as const) {
    const v = config.settle?.[key];
    if (v !== undefined && (typeof v !== 'number' || v < 0)) {
      throw new Error(`settle.${key} must be a number of milliseconds`);
    }
  }
  if (config.ignore !== undefined) {
    const ok =
      Array.isArray(config.ignore) &&
      config.ignore.every(
        (r) =>
          typeof r === 'string' ||
          (r &&
            typeof r === 'object' &&
            typeof (r as { selector?: unknown }).selector === 'string'),
      );
    if (!ok) {
      throw new Error(
        `ignore must be a list of CSS selectors, or { selector, detectors } objects, like [".cookie-banner"]`,
      );
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
