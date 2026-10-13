// Checks the built package the way people will use it: every entry loads from
// both ESM and CommonJS, the source loader tags JSX, and the command runs.
// Run after the build, from this folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

for (const [entry, exported] of [
  ['.', 'defineConfig'],
  ['./vite', 'breakhound'],
  ['./next', 'withBreakhound'],
  ['./webpack', 'BreakhoundPlugin'],
]) {
  const name = entry === '.' ? pkg.name : `${pkg.name}/${entry.slice(2)}`;
  const esm = await import(name);
  const cjs = require(name);
  assert.equal(typeof esm[exported], 'function', `${name} (ESM) is missing ${exported}`);
  assert.equal(typeof cjs[exported], 'function', `${name} (CJS) is missing ${exported}`);
  for (const file of Object.values(pkg.exports[entry]).flatMap((c) => Object.values(c))) {
    assert.ok(existsSync(file), `${file} is listed in exports but wasn't built`);
  }
}
assert.ok(existsSync(pkg.exports['./schema.json']), 'schema.json is missing');
assert.ok(existsSync('dist/inject.js'), 'the page script is missing');

// Next's dev config points Turbopack at the CommonJS loader; run it on some JSX.
const { withBreakhound } = require('@seybel/breakhound/next');
const config = await withBreakhound({})('phase-development-server', { defaultConfig: {} });
const [loader] = config.turbopack.rules['*.jsx'].loaders;
assert.ok(existsSync(loader), `loader ${loader} doesn't exist`);
const out = await new Promise((resolve, reject) => {
  require(loader).call(
    {
      resourcePath: `${process.cwd()}/src/Card.jsx`,
      rootContext: process.cwd(),
      callback: (error, code) => (error ? reject(error) : resolve(code)),
    },
    'export const Card = () => <div className="card">Hi</div>;\n',
  );
});
assert.match(out, /data-bh-src="src\/Card\.jsx:1:/, 'the loader did not tag the element');

const bin = pkg.bin.breakhound;
const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
assert.equal(version, pkg.version);

console.log('Built package looks right.');
