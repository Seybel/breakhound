import { addSourceAttributes, wantsFile } from './transform';

export interface SourcePluginOptions {
  /** Project root that paths are relative to (default: Vite's root). */
  root?: string;
}

/**
 * Vite plugin: `plugins: [breakhound()]`. Runs only on the dev server, before
 * the framework plugins, so production builds are untouched.
 */
export default function breakhound(options: SourcePluginOptions = {}) {
  let root = options.root ?? process.cwd();
  return {
    name: 'breakhound:source',
    enforce: 'pre' as const,
    apply: 'serve' as const,
    configResolved(config: { root: string }) {
      root = options.root ?? config.root;
    },
    transform(code: string, id: string) {
      if (!wantsFile(id)) return null;
      return addSourceAttributes(code, id, root);
    },
  };
}

export { breakhound };
