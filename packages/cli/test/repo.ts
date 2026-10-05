import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A made-up app in a throwaway git repo, for the fix loop: three pages, one
 * stylesheet, and a dev server.
 */

/** Pages are read from disk on every request, so edits show up like with a dev server's hot reload. */
const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const name = path === '/' ? 'home' : path.slice(1);
  let body;
  try { body = readFileSync('pages/' + name + '.html', 'utf8'); } catch { res.writeHead(404); res.end('Not found'); return; }
  const css = readFileSync('styles.css', 'utf8');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}' + css + '</style></head><body><main>' + body + '<nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav></main></body></html>');
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/'));
`;

export const CSS = {
  broken: '.banner { width: 600px; background: #eee }\n.card { width: 520px; background: #ddd }\n',
  pricingFixed:
    '.banner { max-width: 600px; background: #eee }\n.card { width: 520px; background: #ddd }\n',
};

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'breakhound-agent-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'shop', scripts: { dev: 'node server.mjs' } }),
  );
  writeFileSync(join(root, 'server.mjs'), SERVER);
  writeFileSync(join(root, '.gitignore'), '.breakhound/\n');
  writeFileSync(join(root, 'styles.css'), CSS.broken);
  mkdirSync(join(root, 'pages'));
  writeFileSync(join(root, 'pages/home.html'), '<h1>Shop</h1><div class="home">Welcome</div>');
  writeFileSync(
    join(root, 'pages/pricing.html'),
    '<h1>Pricing</h1><div class="banner">Plans for everyone</div>',
  );
  writeFileSync(join(root, 'pages/about.html'), '<h1>About</h1><div class="card">Our story</div>');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Start');
  return root;
}
