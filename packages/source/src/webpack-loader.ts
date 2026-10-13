import { addSourceAttributes } from './transform';

interface LoaderContext {
  resourcePath: string;
  rootContext: string;
  getOptions?: () => { root?: string };
  callback(error: Error | null, code?: string, map?: unknown): void;
}

/** Webpack and Turbopack loader behind @seybel/breakhound/webpack and @seybel/breakhound/next. */
export default function loader(this: LoaderContext, source: string, map?: unknown): void {
  const root = this.getOptions?.()?.root ?? this.rootContext ?? process.cwd();
  const result = addSourceAttributes(source, this.resourcePath, root);
  if (!result) {
    this.callback(null, source, map);
    return;
  }
  this.callback(null, result.code, result.map);
}
