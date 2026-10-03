import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addSourceAttributes, wantsFile } from '../src/transform';

const root = join(import.meta.dirname, '..');
const at = (file: string) => join(root, file);

describe('marking elements with where they are written', () => {
  it('marks HTML elements in JSX and leaves components alone', () => {
    const code = `export const Nav = <T,>({ items }: { items: T[] }) => (
  <nav className="nav">
    <Menu items={items} />
    <ul>{items.map((i) => <li key={String(i)}>{String(i)}</li>)}</ul>
  </nav>
);`;
    const out = addSourceAttributes(code, at('src/Nav.tsx'), root)?.code;
    expect(out).toContain('<nav data-bh-src="src/Nav.tsx:2:3" className="nav">');
    expect(out).toContain('<Menu items={items} />');
    expect(out).toContain('<li data-bh-src="src/Nav.tsx:4:27" key');
  });

  it('keeps lines where they were, so source maps stay simple', () => {
    const code = 'const a = (\n  <div>\n    <p>hi</p>\n  </div>\n);\n';
    const out = addSourceAttributes(code, at('src/a.jsx'), root)?.code ?? '';
    expect(out.split('\n')).toHaveLength(code.split('\n').length);
  });

  it('marks Vue template elements, not components, slots or <template>', () => {
    const code = `<script setup>
const open = true
</script>

<template>
  <div class="card">
    <MyButton />
    <slot />
    <template v-if="open"><span>hi</span></template>
  </div>
</template>
`;
    const out = addSourceAttributes(code, at('src/Card.vue'), root)?.code ?? '';
    expect(out).toContain('<div data-bh-src="src/Card.vue:6:3" class="card">');
    expect(out).toContain('<span data-bh-src="src/Card.vue:9:27">');
    expect(out).toContain('<MyButton />');
    expect(out).toContain('<slot />');
    expect(out).toContain('<template v-if="open">');
  });

  it('marks Svelte elements', () => {
    const code = '<script>\n  let n = 1;\n</script>\n\n<div class="box">\n  <p>{n}</p>\n</div>\n';
    const out = addSourceAttributes(code, at('src/Box.svelte'), root)?.code ?? '';
    expect(out).toContain('<div data-bh-src="src/Box.svelte:5:1" class="box">');
    expect(out).toContain('<p data-bh-src="src/Box.svelte:6:3">');
  });

  it('leaves library code and non-component files alone', () => {
    expect(wantsFile('/app/node_modules/ui/Button.jsx')).toBe(false);
    expect(wantsFile('/app/src/util.ts')).toBe(false);
    expect(wantsFile('/app/src/Card.vue?vue&type=style')).toBe(false);
    expect(
      addSourceAttributes(
        'export const x = <mesh />; import "@react-three/fiber";',
        at('src/Scene.jsx'),
        root,
      ),
    ).toBeNull();
  });
});
