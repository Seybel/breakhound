import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkpoint, listCheckpoints, startSession, undo } from '../src/session';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'breakhound-git-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.breakhound/\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Start');
  return root;
}

describe('checkpoints and undo', () => {
  it('undoes a fix whose neighbouring line changed later', () => {
    const root = repo({ 'a.css': '.x { width: 600px }\n.y { width: 500px }\n' });
    startSession(root);
    writeFileSync(join(root, 'a.css'), '.x { max-width: 600px }\n.y { width: 500px }\n');
    checkpoint(root, { routes: ['/x'] });
    writeFileSync(join(root, 'a.css'), '.x { max-width: 600px }\n.y { max-width: 500px }\n');
    checkpoint(root, { routes: ['/y'] });
    undo(root, { routes: ['/x'] });
    expect(git(root, 'show', 'HEAD:a.css')).toBe('.x { width: 600px }\n.y { max-width: 500px }');
    expect(listCheckpoints(root).map((c) => c.routes)).toEqual([['/y']]);
  });

  it('changes nothing when the fixed lines were edited again since', () => {
    const root = repo({ 'a.css': '.x { width: 600px }\n' });
    startSession(root);
    writeFileSync(join(root, 'a.css'), '.x { max-width: 600px }\n');
    checkpoint(root, { routes: ['/x'] });
    writeFileSync(join(root, 'a.css'), '.x { max-width: 100% }\n');
    git(root, 'commit', '-q', '-am', 'Someone else changed it');
    const before = git(root, 'rev-parse', 'HEAD');
    expect(() => undo(root, { routes: ['/x'] })).toThrow(/Nothing was changed/);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('undoes a whole session, and lists nothing once it is undone', () => {
    const root = repo({ 'a.css': 'a\n', 'b.css': 'b\n' });
    startSession(root);
    writeFileSync(join(root, 'a.css'), 'a2\n');
    checkpoint(root, { routes: ['/a'] });
    writeFileSync(join(root, 'b.css'), 'b2\n');
    checkpoint(root, { routes: ['/b'], message: 'Stop the table overflowing' });
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Stop the table overflowing');
    const r = undo(root, { session: true });
    expect(r.undone).toHaveLength(2);
    expect(git(root, 'show', 'HEAD:a.css')).toBe('a');
    expect(git(root, 'show', 'HEAD:b.css')).toBe('b');
    expect(listCheckpoints(root)).toEqual([]);
    expect(() => undo(root, { routes: ['/a'] })).toThrow(/no breakhound fixes/);
  });

  it('refuses outside git and without changes', () => {
    const plain = mkdtempSync(join(tmpdir(), 'breakhound-nogit-'));
    expect(() => checkpoint(plain, { routes: ['/'] })).toThrow(/not in a git repository/);
    const root = repo({ 'a.css': 'a\n' });
    expect(() => checkpoint(root, { routes: ['/'] })).toThrow(/Nothing has changed/);
    writeFileSync(join(root, 'a.css'), 'a2\n');
    expect(() => checkpoint(root, { routes: ['/'], files: ['b.css'] })).toThrow(/no changes/);
  });
});
