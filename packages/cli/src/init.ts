import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';

const TEMPLATE = (
  baseUrl: string,
  typed: boolean,
) => `${typed ? "import { defineConfig } from '@seybel/breakhound';\n\nexport default defineConfig({" : "/** @type {import('@seybel/breakhound').BreakhoundConfig} */\nexport default {"}
  // breakhound finds your dev server, or starts it, by itself. Set this to
  // scan somewhere else, like a staging site.
  // baseUrl: '${baseUrl}',

  // Every route is found automatically. To narrow it down:
  // include: ['/blog/**'],
  // exclude: ['/admin/**'],
  // Real values for dynamic route parameters no page links to, by name:
  // params: { slug: 'my-first-post', id: '42' },

  // Viewport widths to sweep, in CSS pixels.
  widths: { min: 320, max: 1920 },

  // Leave elements out, e.g. third-party embeds: ['.intercom-launcher', { selector: '.map', detectors: ['overlap'] }]
  ignore: [],

  // Exit with code 1 at this level or worse (error, warning, info or none).
  failOn: 'error',
}${typed ? ')' : ''};
`;

/** Where editors fetch the schema from, so a JSON config gets completion without installing anything. */
export const SCHEMA_URL = 'https://cdn.jsdelivr.net/npm/@seybel/breakhound/dist/schema.json';

const JSON_TEMPLATE = `${JSON.stringify(
  {
    $schema: SCHEMA_URL,
    widths: { min: 320, max: 1920 },
    ignore: [],
    failOn: 'error',
  },
  null,
  2,
)}
`;

/**
 * A config that imports from breakhound only type-checks when breakhound is
 * installed; run through npx it isn't, and the import would break the
 * project's own type check (and builds like next build that run it).
 */
function isInstalled(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.dependencies?.breakhound || pkg.devDependencies?.breakhound);
  } catch {
    return false;
  }
}

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
  const installed = isInstalled(cwd);
  const typed = existsSync(join(cwd, 'tsconfig.json'));
  const file = !installed
    ? 'breakhound.config.json'
    : typed
      ? 'breakhound.config.ts'
      : 'breakhound.config.mjs';
  writeFileSync(join(cwd, file), installed ? TEMPLATE(guessBaseUrl(cwd), typed) : JSON_TEMPLATE);
  console.log(`${styleText('green', '✔')} Created ${file}`);
  if (!installed) {
    console.log(
      styleText(
        'dim',
        `  Your editor suggests every option as you type. For a ${typed ? 'TypeScript' : 'JavaScript'} config instead,\n  add breakhound to your dev dependencies and run init again.`,
      ),
    );
  }

  console.log(`\nNow run ${styleText('bold', 'npx @seybel/breakhound')}.`);
}
