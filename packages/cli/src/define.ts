import type { DetectorId, IgnoreRule, Severity } from '@breakhound/engine/types';

/**
 * The config file's shape. Everything is optional: with no config at all,
 * breakhound finds the app, its routes and its dev server by itself.
 */
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
  server?: {
    /** Command that starts the app, e.g. "npm run dev -- --port 4000". */
    command?: string;
    /** Port to wait on, when the command doesn't print its URL. */
    port?: number;
    /** Seconds to wait for the server to answer (default 120). */
    timeout?: number;
  };
  /** Viewport widths to sweep, in CSS pixels. */
  widths?: {
    /** Narrowest width (default 320). */
    min?: number;
    /** Widest width (default 1920). */
    max?: number;
    /** Step of the first, coarse sweep before narrowing down (default 16). */
    step?: number;
  };
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
  /**
   * Also open menus, dialogs and expandable sections (the mobile menu, a
   * modal, an FAQ) and scan them open. A number sets the most to open on one
   * page (default 5); false turns it off.
   */
  states?: boolean | number;
  /** Also write report.pdf. */
  pdf?: boolean;
  /**
   * Browser engines to scan in: chromium, webkit (Safari's engine) and
   * firefox. The first finds the routes; the others check the same pages after
   * it, one at a time. Default ["chromium"].
   */
  browsers?: ('chromium' | 'webkit' | 'firefox')[];
  /**
   * Also show screenshots of each page at 375, 768 and 1280px to your own
   * vision model (the one `fix` uses, or set one here) and report what it
   * says looks off, as info. Off by default.
   */
  vision?:
    | boolean
    | { provider?: 'anthropic' | 'openai' | 'ollama'; model?: string; widths?: number[] };
  /** The model `breakhound fix` uses; flags and environment variables work too. */
  fix?: {
    /** anthropic, openai (or any compatible API) or ollama. Picked from your environment when left out. */
    provider?: 'anthropic' | 'openai' | 'ollama';
    model?: string;
  };
  /** Browser tabs to use at once (default: half your CPU cores, up to 4). */
  concurrency?: number;
  /**
   * Most memory the dev server and browser breakhound starts may use
   * together before it shuts them down, so a big app can't freeze your
   * computer: a size like "6GB", a share like "50%", or "off". Default 60% of
   * your memory, leaving at least 2 GB free.
   */
  memoryLimit?: string | false;
  /** How long to wait for the page to settle. */
  settle?: {
    /** Most milliseconds to wait for the network to go quiet after load (default 5000). */
    networkIdleMs?: number;
    /** Most milliseconds to wait for the layout to stop moving after a resize (default 1000). */
    maxSettleMs?: number;
  };
}

export function defineConfig(config: BreakhoundConfig): BreakhoundConfig {
  return config;
}
