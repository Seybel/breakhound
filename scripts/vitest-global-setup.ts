import { execFileSync } from 'node:child_process';

// Layout tests inject the analyzer bundle into real pages, so it has to exist first.
export default function setup() {
  execFileSync(process.execPath, ['packages/analyzers/build.mjs'], { stdio: 'inherit' });
}
