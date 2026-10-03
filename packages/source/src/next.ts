import { loaderPath } from './paths';
import { sourceRule } from './webpack';

// biome-ignore lint/suspicious/noExplicitAny: Next's config is a large, loosely typed object.
type NextConfig = Record<string, any>;
type ConfigInput =
  | NextConfig
  | ((phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>);

const DEV_PHASE = 'phase-development-server';

/**
 * `export default withBreakhound(nextConfig)`. Only `next dev` is changed:
 * both Turbopack and webpack get a loader that marks elements with where
 * they're written.
 */
export function withBreakhound(config: ConfigInput = {}) {
  return async (phase: string, context: { defaultConfig: NextConfig }): Promise<NextConfig> => {
    const resolved = typeof config === 'function' ? await config(phase, context) : config;
    if (phase !== DEV_PHASE) return resolved;
    const loader = loaderPath();
    const rules = { ...resolved.turbopack?.rules };
    for (const glob of ['*.jsx', '*.tsx']) {
      // Never replace a rule the project set up itself.
      if (!rules[glob]) rules[glob] = { loaders: [loader] };
    }
    const userWebpack = resolved.webpack;
    return {
      ...resolved,
      turbopack: { ...resolved.turbopack, rules },
      webpack(webpackConfig: NextConfig, options: NextConfig) {
        const out = userWebpack ? userWebpack(webpackConfig, options) : webpackConfig;
        out.module.rules.unshift(sourceRule());
        return out;
      },
    };
  };
}

export default withBreakhound;
