import { loaderPath } from './paths';

interface Compiler {
  options: {
    mode?: string;
    context?: string;
    module: { rules: unknown[] };
  };
}

/** The rule that runs breakhound's loader on the project's own component files. */
export function sourceRule(root?: string) {
  return {
    test: /\.(jsx|tsx|vue|svelte)$/,
    exclude: /[\\/]node_modules[\\/]/,
    enforce: 'pre' as const,
    use: [{ loader: loaderPath(), options: root ? { root } : {} }],
  };
}

/** Webpack plugin: `plugins: [new BreakhoundPlugin()]`. Does nothing in production mode. */
export class BreakhoundPlugin {
  constructor(private readonly options: { root?: string } = {}) {}

  apply(compiler: Compiler): void {
    if (compiler.options.mode === 'production') return;
    compiler.options.module.rules.unshift(
      sourceRule(this.options.root ?? compiler.options.context),
    );
  }
}

export default BreakhoundPlugin;
