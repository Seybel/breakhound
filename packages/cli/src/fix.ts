import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { styleText } from 'node:util';
import type { Issue, Severity } from '@breakhound/engine';
import { formatRanges, groupIssues, type IssueGroup, renderIssue } from '@breakhound/report';
import { type AppServer, resolveServer } from './app';
import type { BreakhoundConfig } from './config';
import { guard, parseMemoryLimit } from './guard';
import type { ModelClient } from './model';
import { changedFiles, checkpoint, gitRoot } from './session';
import { type IssueChange, readBaseline, runVerify, type VerifyOutcome } from './verify';

export interface FixRequest {
  cwd: string;
  config: BreakhoundConfig;
  version: string;
  quiet: boolean;
  model: ModelClient;
  /** Only issues on these routes (or globs); every route when empty. */
  routes?: string[];
  severities: Severity[];
  /** Most issues to try (default 20). */
  limit?: number;
  /** Tries per issue, the later ones told why the earlier failed (default 2). */
  attempts?: number;
  app?: AppServer;
}

export interface FixAttempt {
  title: string;
  routes: string[];
  outcome: 'fixed' | 'not-fixed' | 'skipped';
  reason?: string;
  commit?: string;
  files?: string[];
}

interface SourceFile {
  path: string;
  content: string;
}

export interface Edit {
  file: string;
  search: string;
  replace: string;
}

/** Files people write styles and markup in. */
const SOURCE_FILE =
  /\.(css|scss|sass|less|styl|pcss|html?|vue|svelte|astro|jsx|tsx|js|ts|mjs|mts|cjs|php|erb|hbs|njk|liquid)$/i;
const SKIP_FILE = /(^|\/)(dist|build|out|coverage|vendor|\.next|\.nuxt)\/|\.min\.|\.d\.ts$|\.map$/;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 24_000;
const MAX_SCAN_BYTES = 300_000;
const CONTEXT_LINES = 40;

const SYSTEM = `You fix responsive layout bugs in a web project's source code.

You get one issue that was measured in a real browser at exact viewport widths, and the project files most likely to cause it. Change the code so the issue is gone at the listed widths, and the layout stays the same at every other width.

- Fix the cause: fluid widths, max-width: 100%, min-width: 0 on flex and grid children, wrapping, or a media query. Don't hide it with overflow: hidden.
- Make the smallest change that does it. Only edit the files you were given.
- Reply with one short sentence on what you changed, then the edits, each exactly in this form:

<edit file="path/exactly/as/given">
<search>
lines copied exactly from the file, enough of them to be unique
</search>
<replace>
the lines that replace them
</replace>
</edit>`;

/** Classes, ids and words from the element that are worth searching the code for. */
function searchTerms(issue: Issue): string[] {
  const terms = new Set<string>();
  const add = (s: string) => {
    if (s.length >= 3 && !/^(div|span|nth|of|type|child)$/.test(s)) terms.add(s);
  };
  for (const info of [issue.element, issue.related]) {
    if (!info) continue;
    for (const m of info.selector.matchAll(/[.#]((?:\\.|[\w-])+)/g))
      add((m[1] ?? '').replace(/\\/g, ''));
    for (const cls of info.html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? []) add(cls);
    const id = info.html.match(/\bid="([^"]+)"/)?.[1];
    if (id) add(id);
  }
  const text = issue.element.text?.trim();
  if (text && text.length >= 6) add(text.slice(0, 40));
  return [...terms].slice(0, 12);
}

function trackedFiles(cwd: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0')
      .filter((f) => f && SOURCE_FILE.test(f) && !SKIP_FILE.test(f));
  } catch {
    return [];
  }
}

/** The lines around each match, so a big file costs a few hundred lines rather than all of it. */
function excerpt(content: string, terms: string[]): string {
  if (content.length <= MAX_FILE_BYTES) return content;
  const lines = content.split('\n');
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!terms.some((t) => line.includes(t))) return;
    for (
      let j = Math.max(0, i - CONTEXT_LINES);
      j <= Math.min(lines.length - 1, i + CONTEXT_LINES);
      j++
    )
      keep.add(j);
  });
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out.push('... (lines left out) ...');
    out.push(lines[i] as string);
    last = i;
  }
  return out.join('\n').slice(0, MAX_FILE_BYTES * 2);
}

/**
 * The files to show the model: where the element is written, when the page
 * said so, then the files that mention its classes, ids or text the most.
 */
export function pickFiles(cwd: string, issue: Issue, tracked = trackedFiles(cwd)): SourceFile[] {
  const terms = searchTerms(issue);
  const scores = new Map<string, number>();
  for (const source of [issue.element.source, issue.related?.source]) {
    if (source?.file && existsSync(join(cwd, source.file))) {
      scores.set(source.file, (scores.get(source.file) ?? 0) + 100);
    }
  }
  for (const file of tracked) {
    const full = join(cwd, file);
    try {
      if (statSync(full).size > MAX_SCAN_BYTES) continue;
      const content = readFileSync(full, 'utf8');
      const hits = terms.filter((t) => content.includes(t)).length;
      if (hits) scores.set(file, (scores.get(file) ?? 0) + hits);
    } catch {
      // Deleted since git listed it.
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES)
    .map(([path]) => ({ path, content: excerpt(readFileSync(join(cwd, path), 'utf8'), terms) }));
}

export function parseEdits(reply: string): Edit[] {
  const edits: Edit[] = [];
  const re =
    /<edit\s+file="([^"]+)"\s*>\s*<search>\r?\n?([\s\S]*?)\r?\n?<\/search>\s*<replace>\r?\n?([\s\S]*?)\r?\n?<\/replace>\s*<\/edit>/g;
  for (const m of reply.matchAll(re)) {
    edits.push({
      file: normalize((m[1] ?? '').replace(/^\.\//, '')),
      search: m[2] ?? '',
      replace: m[3] ?? '',
    });
  }
  return edits;
}

/** Finds `search` in `content` exactly, or else line by line ignoring trailing spaces. */
function locate(content: string, search: string): { start: number; end: number } | 'many' | null {
  const first = content.indexOf(search);
  if (first !== -1 && search.trim()) {
    if (content.indexOf(search, first + 1) !== -1) return 'many';
    return { start: first, end: first + search.length };
  }
  const want = search.split('\n').map((l) => l.trimEnd());
  if (!want.some((l) => l.trim())) return null;
  const lines = content.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const found: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => (lines[i + k] as string).trimEnd() === w)) {
      const last = i + want.length - 1;
      found.push({
        start: offsets[i] as number,
        end: (offsets[last] as number) + (lines[last] as string).length,
      });
    }
  }
  if (found.length > 1) return 'many';
  return found[0] ?? null;
}

/**
 * Applies edits to the files the model was shown, all or nothing. Returns the
 * original contents, to put back if the fix doesn't hold.
 */
export function applyEdits(
  cwd: string,
  edits: Edit[],
  allowed: Set<string>,
): { originals: Map<string, string> } | { error: string } {
  const next = new Map<string, string>();
  const originals = new Map<string, string>();
  for (const edit of edits) {
    if (!allowed.has(edit.file)) return { error: `${edit.file} wasn't one of the files given.` };
    const current = next.get(edit.file) ?? readFileSync(join(cwd, edit.file), 'utf8');
    if (!originals.has(edit.file)) originals.set(edit.file, current);
    const at = locate(current, edit.search);
    if (at === 'many') {
      return {
        error: `The search text for ${edit.file} matches more than one place. Include more lines.`,
      };
    }
    if (!at)
      return { error: `The search text for ${edit.file} isn't in the file. Copy it exactly.` };
    next.set(edit.file, current.slice(0, at.start) + edit.replace + current.slice(at.end));
  }
  for (const [file, content] of next) writeFileSync(join(cwd, file), content);
  return { originals };
}

function restore(cwd: string, originals: Map<string, string>): void {
  for (const [file, content] of originals) writeFileSync(join(cwd, file), content);
}

function promptFor(group: IssueGroup, text: string, files: SourceFile[], feedback: string): string {
  const parts = [text, '', 'Files:', ''];
  for (const f of files) parts.push(`<file path="${f.path}">`, f.content, '</file>', '');
  if (feedback) {
    parts.push(`Your last edits were undone because they didn't work: ${feedback}`, 'Try again.');
  }
  if (group.routes.length > 1) {
    parts.push(
      `The same element breaks on ${group.routes.length} pages; one fix should cover them.`,
    );
  }
  return parts.join('\n');
}

function describeFailure(group: IssueGroup, v: VerifyOutcome): string {
  const ids = new Set(group.routes.map((r) => r.issue.id));
  const still = v.failing.filter((c) => ids.has(c.before?.id ?? c.issue.id));
  const parts: string[] = [];
  if (still.length) {
    parts.push(`the issue is still there at ${formatRanges(still[0]?.issue.ranges ?? [])}`);
  }
  if (v.regressions.length) {
    const list = v.regressions
      .slice(0, 3)
      .map((c: IssueChange) => `${c.issue.title} at ${formatRanges(c.issue.ranges)} on ${c.route}`);
    parts.push(`it broke something else: ${list.join('; ')}`);
  }
  if (v.unchecked.length) parts.push('a page stopped loading');
  return parts.join(', and ') || 'it did not verify';
}

function log(quiet: boolean, line: string): void {
  if (!quiet) console.log(line);
}

/**
 * Fixes the last scan's issues one at a time with the developer's own model:
 * shows it the issue and the likely files, applies its edits, and verifies.
 * A fix that holds, with nothing new broken, becomes its own checkpoint
 * commit (so `breakhound undo` can take it back); anything else is put back
 * the way it was.
 */
export function runFix(req: FixRequest): Promise<FixAttempt[]> {
  return guard.run({ limit: parseMemoryLimit(req.config.memoryLimit) }, () => fix(req));
}

async function fix(req: FixRequest): Promise<FixAttempt[]> {
  const { cwd, config, quiet, model } = req;
  const outDir = config.outDir ?? '.breakhound';
  if (!gitRoot(cwd)) {
    throw new Error(
      'breakhound fix commits each fix so it can be undone, and this folder is not in a git repository. Run git init and make a first commit.',
    );
  }
  const baseline = readBaseline(cwd, outDir);
  const wanted = req.routes ?? [];
  const groups = groupIssues(baseline)
    .filter((g) => req.severities.includes(g.issue.severity))
    .filter((g) => !wanted.length || g.routes.some((r) => wanted.includes(r.route.route)))
    .slice(0, req.limit ?? 20);
  if (!groups.length) {
    log(quiet, 'Nothing to fix in the last scan.');
    return [];
  }

  // Files with uncommitted changes may be someone's work in progress.
  const dirty = new Set(changedFiles(cwd, outDir));
  const tracked = trackedFiles(cwd);
  log(
    quiet,
    styleText(
      'dim',
      `Fixing ${groups.length === 1 ? '1 issue' : `${groups.length} issues`} with ${model.model} (${model.provider}). The code around each issue is sent to ${new URL(model.endpoint).origin}.\n`,
    ),
  );

  const app = req.app ?? (await resolveServer(cwd, config, quiet));
  const results: FixAttempt[] = [];
  try {
    for (const [n, group] of groups.entries()) {
      const routes = [...new Set(group.routes.map((r) => r.route.route))];
      const title = group.issue.title;
      log(
        quiet,
        `${styleText('bold', `${n + 1}/${groups.length}`)} ${title} ${styleText('dim', `on ${routes.join(', ')}`)}`,
      );
      const files = pickFiles(cwd, group.issue, tracked).filter((f) => !dirty.has(f.path));
      if (!files.length) {
        const reason = "couldn't tell which file to change (or it has uncommitted changes)";
        results.push({ title, routes, outcome: 'skipped', reason });
        log(quiet, styleText('yellow', `   – skipped: ${reason}`));
        continue;
      }
      const text = renderIssue(baseline, group.fingerprint)?.text ?? title;
      const allowed = new Set(files.map((f) => f.path));
      let feedback = '';
      let done: FixAttempt | null = null;
      for (let attempt = 1; attempt <= (req.attempts ?? 2) && !done; attempt++) {
        // An API error (a bad key, no credit) would fail every issue the same way, so it stops the run.
        const reply = await model.complete(SYSTEM, promptFor(group, text, files, feedback));
        const edits = parseEdits(reply);
        if (!edits.length) {
          feedback = 'the reply had no edits in the format asked for';
          continue;
        }
        const applied = applyEdits(cwd, edits, allowed);
        if ('error' in applied) {
          feedback = applied.error;
          continue;
        }
        const changed = [...applied.originals.keys()];
        const v = await runVerify({ cwd, config, version: req.version, quiet: true, routes, app });
        const ids = new Set(group.routes.map((r) => r.issue.id));
        const holds =
          !v.failing.some((c) => ids.has(c.before?.id ?? c.issue.id)) &&
          !v.regressions.length &&
          !v.unchecked.length;
        if (!holds) {
          restore(cwd, applied.originals);
          feedback = describeFailure(group, v);
          continue;
        }
        const commit = checkpoint(cwd, {
          routes,
          files: changed,
          details: [`${title} at ${formatRanges(group.issue.ranges)}`],
          outDir,
        });
        done = { title, routes, outcome: 'fixed', commit: commit.hash, files: changed };
      }
      if (done) {
        log(
          quiet,
          styleText('green', `   ✔ fixed in ${done.files?.join(', ')}, committed ${done.commit}`),
        );
        results.push(done);
      } else {
        results.push({ title, routes, outcome: 'not-fixed', reason: feedback });
        log(quiet, styleText('red', `   ✖ not fixed, changes undone: ${feedback}`));
      }
    }
  } finally {
    if (!req.app) await app.server?.stop();
  }

  const fixed = results.filter((r) => r.outcome === 'fixed');
  log(quiet, '');
  log(quiet, `Fixed ${fixed.length} of ${results.length}.`);
  if (fixed.length) {
    log(
      quiet,
      styleText(
        'dim',
        'Each fix is its own commit. Take one back with npx @seybel/breakhound undo <route>, or all with npx @seybel/breakhound undo --session.',
      ),
    );
  }
  return results;
}
