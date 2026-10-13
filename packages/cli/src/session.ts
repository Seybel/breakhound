import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { makeOutputFolder } from '@breakhound/report';
import { globMatches } from '@breakhound/routes';

/**
 * Fix sessions, kept in git. A full scan starts a session; each checkpoint is
 * an ordinary commit of the fixes for some routes, tagged with trailers:
 *
 *   Breakhound-Route: /pricing
 *   Breakhound-Session: 5f2c9a1e
 *
 * Undo reverts those commits with new commits, so history is never rewritten
 * and nothing outside breakhound's own commits is touched.
 */

export interface Session {
  id: string;
  startedAt: string;
  /** HEAD when the session started; null in a repo with no commits yet. */
  startCommit: string | null;
  /** Files that already had changes when the session started: the user's, not the fixes. */
  dirtyAtStart: string[];
}

export interface Checkpoint {
  hash: string;
  subject: string;
  routes: string[];
  session: string | null;
}

const SESSION_FILE = 'session.json';

function git(cwd: string, args: string[], input?: string) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: run.status === 0,
    // Only the end: git status lines start with a significant space.
    out: (run.stdout ?? '').trimEnd(),
    err: (run.stderr ?? '').trim() || (run.error?.message ?? ''),
  };
}

export function gitRoot(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out : null;
}

function head(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return r.ok ? r.out : null;
}

/** The report folder, relative to the repo root, so its files are never part of a fix. */
function reportFolder(root: string, cwd: string, outDir: string): string {
  return fromRoot(root, cwd, outDir);
}

/**
 * A path relative to the repo root. git reports the root with symlinks
 * resolved (/private/var on macOS), so the working folder is resolved too.
 */
function fromRoot(root: string, cwd: string, path: string): string {
  let base = cwd;
  try {
    base = realpathSync(cwd);
  } catch {
    // Keep it as given.
  }
  return relative(root, resolve(base, path)).split(sep).join('/');
}

/** Changed and new files, relative to the repo root, leaving out breakhound's own folder. */
export function changedFiles(cwd: string, outDir = '.breakhound'): string[] {
  const root = gitRoot(cwd);
  if (!root) return [];
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return [];
  const skip = reportFolder(root, cwd, outDir);
  const files: string[] = [];
  const entries = r.out.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // A rename lists the old path next; it changed too.
    if (status.includes('R') || status.includes('C')) files.push(entries[++i] as string);
  }
  return files.filter((f) => f !== skip && !f.startsWith(`${skip}/`));
}

function sessionPath(cwd: string, outDir: string): string {
  return join(resolve(cwd, outDir), SESSION_FILE);
}

export function readSession(cwd: string, outDir = '.breakhound'): Session | null {
  const file = sessionPath(cwd, outDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Session;
  } catch {
    return null;
  }
}

function saveSession(cwd: string, outDir: string, session: Session): Session {
  makeOutputFolder(resolve(cwd, outDir));
  writeFileSync(sessionPath(cwd, outDir), `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

/** Starts a fix session, remembering which files the user had already changed. Null outside git. */
export function startSession(cwd: string, outDir = '.breakhound'): Session | null {
  if (!gitRoot(cwd)) return null;
  return saveSession(cwd, outDir, {
    id: randomBytes(4).toString('hex'),
    startedAt: new Date().toISOString(),
    startCommit: head(cwd),
    dirtyAtStart: changedFiles(cwd, outDir),
  });
}

/**
 * Called on every scan. With nothing uncommitted it starts afresh. Otherwise
 * the session goes on, and every file changed right now counts as the
 * user's: breakhound can't tell whose they are, and must never commit
 * someone's work in progress as a fix.
 */
export function touchSession(cwd: string, outDir = '.breakhound'): Session | null {
  if (!gitRoot(cwd)) return null;
  const session = readSession(cwd, outDir);
  const dirty = changedFiles(cwd, outDir);
  if (!session || !dirty.length) return startSession(cwd, outDir);
  return saveSession(cwd, outDir, {
    ...session,
    dirtyAtStart: [...new Set([...session.dirtyAtStart, ...dirty])],
  });
}

export interface CheckpointRequest {
  routes: string[];
  /** Only these files (paths from the project folder); every changed file when left out. */
  files?: string[];
  /** Subject line; a plain default names the routes. */
  message?: string;
  /** Lines for the commit body, e.g. the issues that were fixed. */
  details?: string[];
  outDir?: string;
}

/** Commits the current changes as the fix for some routes. */
export function checkpoint(cwd: string, req: CheckpointRequest): Checkpoint {
  const outDir = req.outDir ?? '.breakhound';
  const root = gitRoot(cwd);
  if (!root) {
    throw new Error(
      'Checkpoints are git commits, and this folder is not in a git repository. Run git init and make a first commit.',
    );
  }
  if (!head(cwd))
    throw new Error('This repository has no commits yet. Make a first commit, then checkpoint.');
  if (!req.routes.length) throw new Error('Say which routes these changes fix, e.g. /pricing.');
  const session = readSession(cwd, outDir) ?? startSession(cwd, outDir);
  if (!session) throw new Error('Could not start a fix session.');

  const all = changedFiles(cwd, outDir);
  let changed = all;
  if (req.files?.length) {
    const wanted = req.files.map((f) => fromRoot(root, cwd, f));
    const unchanged = wanted.filter((f) => !all.includes(f));
    if (unchanged.length) {
      throw new Error(`These files have no changes to commit: ${unchanged.join(', ')}`);
    }
    changed = wanted;
  }
  if (!changed.length) {
    throw new Error(
      'Nothing has changed since the last commit, so there is nothing to checkpoint.',
    );
  }
  const theirs = session.dirtyAtStart.filter((f) => changed.includes(f));
  if (theirs.length) {
    throw new Error(
      `These files had uncommitted changes before breakhound's scan, so they may hold someone's work in progress: ${theirs.join(', ')}. Pass only the files you changed for the fix, or ask the user to commit or stash theirs first.`,
    );
  }

  const subject = (req.message?.trim() || `Fix responsive layout on ${req.routes.join(', ')}`)
    .split('\n')[0]
    ?.slice(0, 100) as string;
  const body = req.details?.length ? `\n\n${req.details.join('\n')}` : '';
  const trailers = [
    ...req.routes.map((r) => `Breakhound-Route: ${r}`),
    `Breakhound-Session: ${session.id}`,
  ];
  const message = `${subject}${body}\n\n${trailers.join('\n')}\n`;

  const add = git(root, ['add', '-A', '--', ...changed]);
  if (!add.ok) throw new Error(`git add failed: ${add.err}`);
  const commit = git(root, ['commit', '--quiet', '-F', '-', '--', ...changed], message);
  if (!commit.ok) {
    // Leave the index the way it was, so a failing hook doesn't leave things half staged.
    git(root, ['reset', '--quiet', '--', ...changed]);
    throw new Error(`git commit failed: ${commit.err}`);
  }
  return {
    hash: git(root, ['rev-parse', '--short', 'HEAD']).out,
    subject,
    routes: req.routes,
    session: session.id,
  };
}

const MARK = '--breakhound-commit--';

/** breakhound's fix commits on the current branch, newest first, leaving out ones already undone. */
export function listCheckpoints(cwd: string, limit = 500): Checkpoint[] {
  const root = gitRoot(cwd);
  if (!root || !head(cwd)) return [];
  const r = git(root, ['log', `-n${limit}`, `--format=${MARK}%n%H%n%B`]);
  if (!r.ok) return [];
  const undone = new Set<string>();
  const found: Checkpoint[] = [];
  for (const chunk of r.out.split(`${MARK}\n`).filter(Boolean)) {
    const [hash = '', ...body] = chunk.split('\n');
    const text = body.join('\n');
    for (const m of text.matchAll(/^Breakhound-Undo: *(\S+)/gm)) undone.add(m[1] as string);
    const routes = [...text.matchAll(/^Breakhound-Route: *(.+)$/gm)].map((m) =>
      (m[1] as string).trim(),
    );
    if (!routes.length || [...text.matchAll(/^Breakhound-Undo:/gm)].length) continue;
    found.push({
      hash,
      subject: body[0] ?? '',
      routes,
      session: text.match(/^Breakhound-Session: *(\S+)/m)?.[1] ?? null,
    });
  }
  return found.filter((c) => ![...undone].some((u) => c.hash.startsWith(u)));
}

/**
 * git revert gives up when a later commit changed a neighbouring line, which
 * is common when fixes for different pages sit next to each other in one CSS
 * file. This takes back only the lines each fix changed, and only where
 * those lines are still exactly what the fix left; otherwise it fails and
 * the caller puts everything back.
 */
function reverseExactLines(root: string, picked: Checkpoint[]): boolean {
  for (const c of picked) {
    const patch = spawnSync('git', ['diff', '--binary', '-U0', `${c.hash}^`, c.hash], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (patch.status !== 0) return false;
    if (!git(root, ['apply', '-R', '--unidiff-zero', '--index', '-'], patch.stdout).ok)
      return false;
  }
  return true;
}

/** Puts back the files a revert staged, touching nothing else. */
function restore(root: string): void {
  if (git(root, ['revert', '--abort']).ok) return;
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', 'HEAD'])
    .out.split('\0')
    .filter(Boolean);
  for (const file of staged) {
    const inHead = git(root, ['cat-file', '-e', `HEAD:${file}`]).ok;
    if (inHead) git(root, ['checkout', '--quiet', 'HEAD', '--', file]);
    else git(root, ['rm', '--quiet', '-f', '--', file]);
  }
}

export interface UndoRequest {
  /** Routes (or globs) whose fixes to undo. */
  routes?: string[];
  /** Undo every fix of the current session instead. */
  session?: boolean;
  outDir?: string;
}

export interface UndoResult {
  undone: Checkpoint[];
  /** Routes that were undone too because they shared a commit with the ones asked for. */
  alsoUndone: string[];
  hash: string;
}

/**
 * Reverts breakhound's fix commits for some routes in one new commit. It
 * refuses to run with uncommitted changes, and if a revert doesn't apply
 * cleanly nothing is changed at all.
 */
export function undo(cwd: string, req: UndoRequest): UndoResult {
  const outDir = req.outDir ?? '.breakhound';
  const root = gitRoot(cwd);
  if (!root)
    throw new Error('Undo works on git commits, and this folder is not in a git repository.');
  const dirty = changedFiles(cwd, outDir);
  if (dirty.length) {
    throw new Error(
      `There are uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit or stash them first; undo never touches them.`,
    );
  }
  const all = listCheckpoints(cwd);
  let picked: Checkpoint[];
  if (req.session) {
    const session = readSession(cwd, outDir);
    if (!session) throw new Error('There is no fix session to undo. Scan first to start one.');
    picked = all.filter((c) => c.session === session.id);
  } else {
    const wanted = req.routes ?? [];
    if (!wanted.length)
      throw new Error(
        'Say which routes to undo, e.g. npx @seybel/breakhound undo /pricing, or pass --session.',
      );
    picked = all.filter((c) =>
      c.routes.some((r) => wanted.some((w) => w === r || globMatches(w, r))),
    );
  }
  if (!picked.length) {
    throw new Error(
      all.length
        ? `No breakhound fixes match. Fixes you can undo: ${[...new Set(all.flatMap((c) => c.routes))].join(', ')}`
        : 'There are no breakhound fixes to undo on this branch.',
    );
  }

  // Newest first, so later fixes come off before the ones they built on.
  const revert = git(root, ['revert', '--no-commit', ...picked.map((c) => c.hash)]);
  if (!revert.ok) {
    git(root, ['revert', '--abort']);
    if (!reverseExactLines(root, picked)) {
      restore(root);
      throw new Error(
        `Couldn't undo cleanly: later commits changed the same lines. Nothing was changed. (${revert.err.split('\n')[0]})`,
      );
    }
  }
  const routes = [...new Set(picked.flatMap((c) => c.routes))];
  const asked = req.routes ?? [];
  const alsoUndone = req.session
    ? []
    : routes.filter((r) => !asked.some((w) => w === r || globMatches(w, r)));
  const message = [
    `Undo responsive fix${picked.length === 1 ? '' : 'es'} on ${routes.join(', ')}`,
    '',
    ...picked.map((c) => `Reverts ${c.hash.slice(0, 10)} (${c.subject}).`),
    '',
    ...picked.map((c) => `Breakhound-Undo: ${c.hash}`),
    '',
  ].join('\n');
  const commit = git(root, ['commit', '--quiet', '-F', '-'], message);
  if (!commit.ok) {
    restore(root);
    throw new Error(`git commit failed, nothing was changed: ${commit.err}`);
  }
  return { undone: picked, alsoUndone, hash: git(root, ['rev-parse', '--short', 'HEAD']).out };
}
