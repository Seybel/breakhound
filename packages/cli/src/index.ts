#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import type { Severity } from '@breakhound/engine';
import { renderPrompt } from '@breakhound/report';
import { copyToClipboard } from './clipboard';
import { type BreakhoundConfig, loadConfig } from './config';
import { runInit } from './init';
import { openInDefaultApp } from './open';
import { readLastResult, runScan } from './scan';
import { readVersion } from './version';

const VERSION = readVersion();

const HELP = `breakhound ${VERSION}
Find where your layout breaks across every viewport width.

Usage
  breakhound [url or path ...]   Scan pages (defaults to the routes in your config)
  breakhound report              Open the last HTML report
  breakhound prompt              Print the fix prompt for your coding agent
  breakhound init                Create a breakhound config file

Scan options
  --min <px>            Narrowest width (default 320)
  --max <px>            Widest width (default 1920)
  --step <px>           Coarse sweep step before bisecting (default 16)
  --fail-on <level>     Exit 1 at: error, warning, info or none (default error)
  --out <dir>           Report folder (default .breakhound)
  --pdf                 Also write report.pdf
  --no-screenshots      Skip issue screenshots
  --concurrency <n>     Browser tabs per page
  --config <file>       Use this config file
  --open                Open the HTML report when done
  -q, --quiet           Only print errors

Prompt options
  --copy                Copy to the clipboard instead of printing
  --all                 Include info-level issues

  -h, --help            Show this help
  -v, --version         Show the version
`;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      min: { type: 'string' },
      max: { type: 'string' },
      step: { type: 'string' },
      'fail-on': { type: 'string' },
      out: { type: 'string' },
      pdf: { type: 'boolean' },
      screenshots: { type: 'boolean' },
      concurrency: { type: 'string' },
      config: { type: 'string' },
      open: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      copy: { type: 'boolean' },
      all: { type: 'boolean' },
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

  const cwd = process.cwd();
  const [command, ...rest] = positionals;

  if (command === 'init') {
    runInit(cwd);
    return 0;
  }

  const { config: fileConfig } = await loadConfig(cwd, values.config);
  const outDir = values.out ?? fileConfig.outDir ?? '.breakhound';

  if (command === 'report') {
    const file = join(cwd, outDir, 'report.html');
    if (!existsSync(file)) throw new Error('No report yet. Run breakhound first.');
    openInDefaultApp(file);
    console.log(file);
    return 0;
  }

  if (command === 'prompt') {
    const { result } = readLastResult(cwd, outDir);
    const prompt = renderPrompt(result, {
      severities: values.all ? ['error', 'warning', 'info'] : ['error', 'warning'],
      verifyCommand: 'npx breakhound',
    });
    if (values.copy) {
      if (copyToClipboard(prompt)) {
        console.log(
          `${styleText('green', '✔')} Fix prompt copied. Paste it into your coding agent.`,
        );
        return 0;
      }
      console.error('No clipboard tool found, printing instead:\n');
    }
    process.stdout.write(`${prompt}\n`);
    return 0;
  }

  const minWidth = positiveInt('min', values.min);
  const maxWidth = positiveInt('max', values.max);
  const step = positiveInt('step', values.step);
  const concurrency = positiveInt('concurrency', values.concurrency);
  const failOn = values['fail-on'] ?? fileConfig.failOn ?? 'error';
  if (failOn !== 'none' && !(failOn in SEVERITY_RANK)) {
    throw new Error('--fail-on must be one of: error, warning, info, none');
  }

  const config: BreakhoundConfig = {
    ...fileConfig,
    outDir,
    widths: {
      ...fileConfig.widths,
      ...(minWidth ? { min: minWidth } : {}),
      ...(maxWidth ? { max: maxWidth } : {}),
      ...(step ? { step } : {}),
    },
    ...(values.pdf !== undefined ? { pdf: values.pdf } : {}),
    ...(values.screenshots !== undefined ? { screenshots: values.screenshots } : {}),
    ...(concurrency ? { concurrency } : {}),
  };
  const targets = command === 'scan' ? rest : positionals;

  const { result, reports } = await runScan({
    targets,
    config,
    cwd,
    version: VERSION,
    quiet: values.quiet ?? false,
  });
  if (values.open) openInDefaultApp(reports.html);

  if (result.routes.some((r) => r.status === 'error')) return 2;
  if (failOn === 'none') return 0;
  const threshold = SEVERITY_RANK[failOn as Severity];
  const failing = result.routes.some((r) =>
    r.issues.some((i) => SEVERITY_RANK[i.severity] <= threshold),
  );
  return failing ? 1 : 0;
}

main(process.argv.slice(2)).then(
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
