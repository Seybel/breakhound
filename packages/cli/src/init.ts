import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { ignoreBreakhoundFolder } from './auth';

const TEMPLATE = (
  baseUrl: string,
  typed: boolean,
) => `${typed ? "import { defineConfig } from 'breakhound';\n\nexport default defineConfig({" : "/** @type {import('breakhound').BreakhoundConfig} */\nexport default {"}
  // breakhound finds your dev server, or starts it, by itself. Set this to
  // scan somewhere else, like a staging site.
  // baseUrl: '${baseUrl}',

  // Every route is found automatically. To narrow it down:
  // include: ['/blog/**'],
  // exclude: ['/admin/**'],
  // A real URL for dynamic routes that no page links to:
  // samples: { '/products/[id]': '/products/42' },

  // Viewport widths to sweep, in CSS pixels.
  widths: { min: 320, max: 1920 },

  // Leave elements out, e.g. third-party embeds: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }]
  ignore: [],

  // Exit with code 1 at this level or worse (error, warning, info or none).
  failOn: 'error',
}${typed ? ')' : ''};
`;

function guessBaseUrl(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const dev: string = pkg.scripts?.dev ?? '';
    const port = dev.match(/(?:--port|-p)[ =](\d{2,5})/)?.[1];
    if (port) return `http://localhost:${port}`;
    if (deps.astro) return 'http://localhost:4321';
    if (deps.nuxt || deps.next) return 'http://localhost:3000';
    if (deps.vite || deps['@sveltejs/kit']) return 'http://localhost:5173';
    if (deps['@angular/core']) return 'http://localhost:4200';
    if (deps['@vue/cli-service']) return 'http://localhost:8080';
  } catch {
    // No package.json: fall through to the common default.
  }
  return 'http://localhost:3000';
}

export function runInit(cwd: string): void {
  const existing = ['ts', 'mts', 'js', 'mjs', 'cjs', 'json']
    .map((ext) => `breakhound.config.${ext}`)
    .find((f) => existsSync(join(cwd, f)));
  if (existing) {
    console.log(`${existing} already exists. Nothing to do.`);
    return;
  }
  const typed = existsSync(join(cwd, 'tsconfig.json'));
  const file = typed ? 'breakhound.config.ts' : 'breakhound.config.mjs';
  const baseUrl = guessBaseUrl(cwd);
  writeFileSync(join(cwd, file), TEMPLATE(baseUrl, typed));
  console.log(`${styleText('green', '✔')} Created ${file}`);

  if (ignoreBreakhoundFolder(cwd)) {
    console.log(`${styleText('green', '✔')} Added .breakhound/ to .gitignore`);
  }
  console.log(`\nNow run ${styleText('bold', 'npx breakhound')}.`);
}
