import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeOutputFolder } from '../src/write';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('the report folder', () => {
  it('keeps itself out of git without touching the project .gitignore', () => {
    const root = mkdtempSync(join(tmpdir(), 'breakhound-folder-'));
    git(root, 'init', '-q');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    writeFileSync(join(root, 'index.html'), '<h1>Home</h1>');

    makeOutputFolder(join(root, '.breakhound'));
    writeFileSync(join(root, '.breakhound/result.json'), '{}');
    writeFileSync(join(root, '.breakhound/auth.json'), '{}');

    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '?? .gitignore\n?? index.html\n',
    );
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');

    // A folder of the developer's own choosing too, and their edits to its .gitignore are kept.
    writeFileSync(join(root, '.breakhound/.gitignore'), '*\n!keep.md\n');
    makeOutputFolder(join(root, '.breakhound'));
    expect(readFileSync(join(root, '.breakhound/.gitignore'), 'utf8')).toBe('*\n!keep.md\n');
    makeOutputFolder(join(root, 'reports/responsive'));
    writeFileSync(join(root, 'reports/responsive/report.html'), '');
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).not.toContain('reports');
  });
});
