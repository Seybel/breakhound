import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import {
  BROWSER_NAMES,
  type BrowserName,
  FAILED_STATUSES,
  type Severity,
} from '@breakhound/engine';
import { renderPrompt } from '@breakhound/report';
import { runLogin } from './auth';
import { installBrowsers } from './browser';
import { isCI, reportToGitHub } from './ci';
import { copyToClipboard } from './clipboard';
import { type BreakhoundConfig, loadConfig, validateConfig } from './config';
import { runFix } from './fix';
import { MemoryError, parseMemoryLimit } from './guard';
import { runInit } from './init';
import { runMcpServer } from './mcp';
import { type ClientId, installMcp } from './mcp-install';
import { PROVIDERS, type Provider, resolveModel } from './model';
import { openInDefaultApp } from './open';
import { readLastResult, runScan } from './scan';
import { checkpoint, listCheckpoints, undo } from './session';
import { formatVerify, runVerify, severitiesAtOrAbove, verifyPassed } from './verify';
import { readVersion } from './version';

const VERSION = readVersion();

const HELP = `breakhound ${VERSION}
Find where your layout breaks across every viewport width.
Run it with npx @seybel/breakhound, or as breakhound once it's installed in your project.

Usage
  breakhound                     Find your app and scan every route
  breakhound /pricing /blog      Scan only these routes of your app
  breakhound <url or file ...>   Scan just these pages
  breakhound login [route]       Log in once in a browser window; later scans reuse the session
  breakhound report              Open the last HTML report
  breakhound prompt              Print the fix prompt for your coding agent
  breakhound init                Create a breakhound config file
  breakhound install [browsers]  Download Chromium, or webkit and firefox (--with-deps adds Linux libraries)

Fixing
  breakhound verify [routes]     Scan again and compare with the last full scan: fixed, still there, new
  breakhound checkpoint <routes> Commit the current changes as the fix for these routes (-m for a message)
  breakhound undo [routes]       Revert the fixes for these routes (--session for all); lists them with no routes
  breakhound fix [routes]        Fix the last scan's issues with your own model (Anthropic or OpenAI key, or
                                 a local Ollama), verify each fix and commit it so it can be undone
  breakhound mcp install         Add breakhound's MCP server to Claude Code, Cursor, VS Code, Windsurf or Codex
  breakhound mcp                 Run the MCP server (your agent starts it)

Scan options
  --url <url>           Where your app runs, e.g. a staging site (skips finding the dev server)
  --include <glob>      Only scan matching routes, e.g. '/blog/**' (repeatable)
  --exclude <glob>      Skip matching routes, e.g. '/admin/**' (repeatable)
  --max-routes <n>      Most routes to scan (default 100)
  --min <px>            Narrowest width (default 320)
  --max <px>            Widest width (default 1920)
  --step <px>           Coarse sweep step before bisecting (default 16)
  --fail-on <level>     Exit 1 at: error, warning, info or none (default error)
  --out <dir>           Report folder (default .breakhound)
  --pdf                 Also write report.pdf
  --no-screenshots      Skip issue screenshots
  --no-states           Don't open menus, dialogs and expandable sections
  --browsers <list>     Also check other engines, e.g. chromium,webkit,firefox
  --vision              Also ask your own vision model what looks off (info only;
                        uses the same model setup as fix)
  --concurrency <n>     Browser tabs to use at once
  --memory-limit <size> Stop before the dev server and browser use more, e.g. 6GB,
                        50% or off (default 60% of your memory)
  --config <file>       Use this config file
  --open                Open the HTML report when done
  -q, --quiet           Only print errors

Prompt and verify options
  --copy                Copy to the clipboard instead of printing
  --all                 Include info-level issues

Fix options
  --provider <name>     anthropic, openai or ollama (default: whichever is set up:
                        ANTHROPIC_API_KEY, OPENAI_API_KEY, then a local Ollama)
  --model <name>        The model to ask, e.g. a model you pulled into Ollama
  --limit <n>           Most issues to try (default 20)
  --all                 Include info-level issues

MCP install options
  --client <name>       claude, cursor, vscode, windsurf or codex (repeatable)
  -y, --yes             Don't ask before changing files

  -h, --help            Show this help
  -v, --version         Show the version
`;

function normalizeBaseUrl(url: string): string {
  const full = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  try {
    return new URL(full).href.replace(/\/+$/, '');
  } catch {
    throw new Error(`--url must be a URL like http://localhost:3000 (got "${url}")`);
  }
}

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
      url: { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      'max-routes': { type: 'string' },
      'with-deps': { type: 'boolean' },
      min: { type: 'string' },
      max: { type: 'string' },
      step: { type: 'string' },
      'fail-on': { type: 'string' },
      out: { type: 'string' },
      pdf: { type: 'boolean' },
      screenshots: { type: 'boolean' },
      states: { type: 'boolean' },
      browsers: { type: 'string' },
      vision: { type: 'boolean' },
      concurrency: { type: 'string' },
      'memory-limit': { type: 'string' },
      config: { type: 'string' },
      open: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      copy: { type: 'boolean' },
      all: { type: 'boolean' },
      message: { type: 'string', short: 'm' },
      session: { type: 'boolean' },
      client: { type: 'string', multiple: true },
      provider: { type: 'string' },
      model: { type: 'string' },
      limit: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
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
  const askedFailOn = values['fail-on'];
  if (
    askedFailOn !== undefined &&
    askedFailOn !== 'none' &&
    !Object.hasOwn(SEVERITY_RANK, askedFailOn)
  ) {
    throw new Error('--fail-on must be one of: error, warning, info, none');
  }

  if (command === 'init') {
    runInit(cwd);
    return 0;
  }
  if (command === 'install') {
    const names = rest.length ? rest : ['chromium'];
    const unknown = names.filter((n) => !(BROWSER_NAMES as readonly string[]).includes(n));
    if (unknown.length) {
      throw new Error(`Unknown browser ${unknown.join(', ')}. Use: ${BROWSER_NAMES.join(', ')}`);
    }
    installBrowsers(names as BrowserName[], values['with-deps'] ?? false);
    return 0;
  }
  if (command === 'mcp') {
    if (rest[0] === 'install') {
      const clients = values.client ?? [];
      const known = ['claude', 'cursor', 'vscode', 'windsurf', 'codex'];
      const unknown = clients.filter((c) => !known.includes(c));
      if (unknown.length)
        throw new Error(`Unknown --client ${unknown.join(', ')}. Use one of: ${known.join(', ')}`);
      return installMcp(cwd, { clients: clients as ClientId[], yes: values.yes ?? false });
    }
    await runMcpServer(VERSION);
    return 0;
  }

  const { config: loaded, warnings } = await loadConfig(cwd, values.config);
  for (const w of warnings) console.error(styleText('yellow', `⚠ ${w}`));
  const memoryLimit = values['memory-limit'];
  if (memoryLimit !== undefined) parseMemoryLimit(memoryLimit);
  const fileConfig: BreakhoundConfig = {
    ...loaded,
    ...(values.url ? { baseUrl: normalizeBaseUrl(values.url) } : {}),
    ...(memoryLimit !== undefined ? { memoryLimit } : {}),
  };

  if (command === 'login') {
    if (isCI())
      throw new Error(
        'breakhound login opens a browser window, so it has to run on your own machine.',
      );
    await runLogin(cwd, fileConfig, rest[0] ? { path: rest[0] } : {});
    return 0;
  }
  const outDir = values.out ?? fileConfig.outDir ?? '.breakhound';

  if (command === 'report') {
    const file = join(resolve(cwd, outDir), 'report.html');
    if (!existsSync(file)) throw new Error('No report yet. Run breakhound first.');
    openInDefaultApp(file);
    console.log(file);
    return 0;
  }

  if (command === 'checkpoint') {
    const c = checkpoint(cwd, {
      routes: rest,
      ...(values.message ? { message: values.message } : {}),
      outDir,
    });
    console.log(`${styleText('green', '✔')} Committed ${c.hash}: ${c.subject}`);
    return 0;
  }

  if (command === 'undo') {
    if (!rest.length && !values.session) {
      const list = listCheckpoints(cwd);
      if (!list.length) console.log('There are no breakhound fixes to undo on this branch.');
      for (const c of list)
        console.log(
          `  ${c.hash.slice(0, 10)}  ${c.routes.join(', ')}  ${styleText('dim', c.subject)}`,
        );
      if (list.length)
        console.log(
          styleText(
            'dim',
            '\nnpx @seybel/breakhound undo <route> undoes one; --session undoes them all.',
          ),
        );
      return 0;
    }
    const r = undo(cwd, { routes: rest, session: values.session ?? false, outDir });
    console.log(
      `${styleText('green', '✔')} Undid ${r.undone.length} fix${r.undone.length === 1 ? '' : 'es'} in commit ${r.hash}`,
    );
    if (r.alsoUndone.length)
      console.log(`  This also undid ${r.alsoUndone.join(', ')}, fixed in the same commit.`);
    return 0;
  }

  if (command === 'verify') {
    const verifyFailOn = (values['fail-on'] ?? (values.all ? 'info' : 'warning')) as
      | Severity
      | 'none';
    const v = await runVerify({
      cwd,
      config: { ...fileConfig, outDir },
      version: VERSION,
      quiet: values.quiet ?? false,
      routes: rest,
    });
    const severities = verifyFailOn === 'none' ? [] : severitiesAtOrAbove(verifyFailOn);
    console.log(
      `\n${formatVerify(v, severities.length ? severities : severitiesAtOrAbove('info'))}`,
    );
    reportToGitHub(v.current, v.reports.summary);
    if (v.unchecked.length) return 2;
    return severities.length && !verifyPassed(v, severities) ? 1 : 0;
  }

  if (command === 'fix') {
    const provider = values.provider ?? fileConfig.fix?.provider;
    if (provider && !(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`--provider must be one of: ${PROVIDERS.join(', ')}`);
    }
    const model = await resolveModel({
      ...(provider ? { provider: provider as Provider } : {}),
      ...((values.model ?? fileConfig.fix?.model)
        ? { model: values.model ?? fileConfig.fix?.model }
        : {}),
    });
    const limit = positiveInt('limit', values.limit);
    const results = await runFix({
      cwd,
      config: { ...fileConfig, outDir },
      version: VERSION,
      quiet: values.quiet ?? false,
      model,
      routes: rest,
      severities: values.all ? ['error', 'warning', 'info'] : ['error', 'warning'],
      ...(limit ? { limit } : {}),
    });
    return results.some((r) => r.outcome !== 'fixed') ? 1 : 0;
  }

  if (command === 'prompt') {
    const { result } = readLastResult(cwd, outDir);
    const prompt = renderPrompt(result, {
      severities: values.all ? ['error', 'warning', 'info'] : ['error', 'warning'],
      verifyCommand: 'npx @seybel/breakhound verify',
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
  const maxRoutes = positiveInt('max-routes', values['max-routes']);
  const failOn = values['fail-on'] ?? fileConfig.failOn ?? 'error';
  if (failOn !== 'none' && !Object.hasOwn(SEVERITY_RANK, failOn)) {
    throw new Error('--fail-on must be one of: error, warning, info, none');
  }

  const browsers = values.browsers
    ?.split(',')
    .map((b) => b.trim().toLowerCase())
    .filter(Boolean) as BrowserName[] | undefined;
  if (browsers) validateConfig({ browsers });

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
    ...(values.states === false ? { states: false } : {}),
    ...(browsers ? { browsers } : {}),
    ...(values.vision !== undefined ? { vision: values.vision } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(maxRoutes ? { maxRoutes } : {}),
    ...(values.include?.length ? { include: values.include } : {}),
    ...(values.exclude?.length ? { exclude: values.exclude } : {}),
  };
  const targets = command === 'scan' ? rest : positionals;

  const { result, reports } = await runScan({
    targets,
    config,
    cwd,
    version: VERSION,
    quiet: values.quiet ?? false,
  });
  if (reports) {
    reportToGitHub(result, reports.summary);
    if (values.open && !isCI()) openInDefaultApp(reports.html);
  }

  // A page that failed to load or rendered nothing wasn't checked, so the run can't pass.
  if (result.routes.some((r) => FAILED_STATUSES.includes(r.status))) return 2;
  if (failOn === 'none') return 0;
  const threshold = SEVERITY_RANK[failOn as Severity];
  const failing = result.routes.some((r) =>
    r.issues.some((i) => SEVERITY_RANK[i.severity] <= threshold),
  );
  return failing ? 1 : 0;
}

// Ctrl+C (or a closed terminal) has to go through process.exit, so the dev
// server breakhound started is stopped too. Otherwise it keeps the port.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
  process.once(signal, () => process.exit(code));
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
    // Don't wait on the scan the guard abandoned; exiting also stops anything left over.
    if (error instanceof MemoryError) process.exit(2);
  },
);
