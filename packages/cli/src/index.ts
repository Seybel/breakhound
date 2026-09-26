#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import { type Issue, type PageResult, type Severity, scanPage } from '@breakhound/engine';

const VERSION = '0.0.0';

const HELP = `breakhound ${VERSION}
Find where your layout breaks across every viewport width.

Usage
  breakhound <url or file> [options]

Options
  --min <px>          Narrowest width to check (default 320)
  --max <px>          Widest width to check (default 1920)
  --step <px>         Coarse sweep step before bisecting (default 16)
  --json <file>       Where to write the raw result (default .breakhound/result.json)
  --fail-on <level>   Exit non-zero at this severity: error, warning, info, none (default error)
  -h, --help          Show this help
  -v, --version       Show the version
`;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function toUrl(target: string): string {
  if (/^https?:\/\//i.test(target) || target.startsWith('file:')) return target;
  if (/^localhost(:\d+)?/i.test(target)) return `http://${target}`;
  return pathToFileURL(resolve(target)).href;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

function ranges(issue: Issue): string {
  return issue.ranges
    .map((r) => (r.from === r.to ? `${r.from}px` : `${r.from}–${r.to}px`))
    .join(', ');
}

function badge(severity: Severity): string {
  if (severity === 'error') return styleText('red', '✖ error  ');
  if (severity === 'warning') return styleText('yellow', '⚠ warning');
  return styleText('blue', 'ℹ info   ');
}

function print(result: PageResult): void {
  const label = result.url.startsWith('file:')
    ? decodeURIComponent(new URL(result.url).pathname)
    : result.url;
  if (result.status !== 'scanned') {
    console.log(`\n  ${styleText('red', '✖')} ${label}\n    ${result.error}`);
    return;
  }
  const bps = result.breakpoints.observed;
  const layout = bps.length
    ? `${bps.length} layout breakpoint${bps.length === 1 ? '' : 's'} (${bps.join(', ')})`
    : 'no layout breakpoints';
  const status = result.issues.length
    ? styleText('red', `${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}`)
    : styleText('green', 'clean');
  console.log(`\n  ${styleText('bold', label)}  ${status} · ${layout}`);

  for (const issue of result.issues) {
    console.log(
      `    ${badge(issue.severity)}  ${styleText('bold', ranges(issue).padEnd(16))} ${issue.title}`,
    );
    console.log(styleText('dim', `               ${issue.element.selector}`));
  }
  if (result.breakpoints.unexplained.length) {
    console.log(
      styleText(
        'dim',
        `    Layout also changes at ${result.breakpoints.unexplained.join(', ')}px with no media query there.`,
      ),
    );
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      min: { type: 'string' },
      max: { type: 'string' },
      step: { type: 'string' },
      json: { type: 'string' },
      'fail-on': { type: 'string', default: 'error' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const target = positionals[0];
  if (!target) {
    console.log(HELP);
    return 2;
  }

  const failOn = values['fail-on'];
  if (failOn !== 'none' && !(failOn in SEVERITY_RANK)) {
    throw new Error('--fail-on must be one of: error, warning, info, none');
  }
  const minWidth = positiveInt('min', values.min, 320);
  const maxWidth = positiveInt('max', values.max, 1920);
  if (minWidth >= maxWidth) throw new Error('--min must be smaller than --max');

  const url = toUrl(target);
  console.log(styleText('dim', `breakhound ${VERSION} · scanning ${minWidth}–${maxWidth}px`));
  const result = await scanPage(url, {
    minWidth,
    maxWidth,
    step: positiveInt('step', values.step, 16),
  });
  print(result);

  const jsonPath = resolve(values.json ?? '.breakhound/result.json');
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    styleText(
      'dim',
      `\n  ${(result.durationMs / 1000).toFixed(1)}s · ${result.measurements} widths measured · ${jsonPath}`,
    ),
  );

  if (result.status !== 'scanned') return 2;
  if (failOn === 'none') return 0;
  const threshold = SEVERITY_RANK[failOn as Severity];
  return result.issues.some((i) => SEVERITY_RANK[i.severity] <= threshold) ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      styleText('red', `breakhound: ${error instanceof Error ? error.message : String(error)}`),
    );
    process.exitCode = 2;
  },
);
