import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DetectorId, IgnoreRule, Severity } from '@breakhound/engine';

export interface BreakhoundConfig {
  /** Where your app is running, e.g. http://localhost:3000. */
  baseUrl?: string;
  /** Pages to scan: paths (joined to baseUrl) or full URLs. */
  routes?: string[];
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
  /** Browser tabs used to measure one page in parallel. */
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
}

export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const file = explicit
    ? resolve(cwd, explicit)
    : CONFIG_FILES.map((f) => join(cwd, f)).find((f) => existsSync(f));
  if (!file) return { config: {}, file: null };
  if (!existsSync(file)) throw new Error(`Config file not found: ${file}`);

  if (file.endsWith('.json')) {
    return { config: JSON.parse(readFileSync(file, 'utf8')) as BreakhoundConfig, file };
  }
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const mod = await jiti.import<{ default?: BreakhoundConfig } | BreakhoundConfig>(file);
  const config = (mod && 'default' in mod ? mod.default : mod) as BreakhoundConfig | undefined;
  if (!config || typeof config !== 'object') {
    throw new Error(`${file} must export a config object (export default defineConfig({ ... }))`);
  }
  return { config, file };
}

export function normalizeIgnore(ignore: BreakhoundConfig['ignore']): IgnoreRule[] {
  return (ignore ?? []).map((rule) => (typeof rule === 'string' ? { selector: rule } : rule));
}
