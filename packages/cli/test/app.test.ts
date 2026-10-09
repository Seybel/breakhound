import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_FILE, runLogin } from '../src/auth';
import { runScan } from '../src/scan';

/**
 * A made-up app with no framework: its dev script starts a small server that
 * prints its URL, like real dev servers do. It has a page that needs a login,
 * a logout link that must never be followed, and a blog with many posts.
 */
const SERVER = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const page = (body) => '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px/1.4 Arial,sans-serif}main{padding:16px}</style></head><body><main>' + body + '</main></body></html>';
const nav = '<a href="/about">About</a> <a href="/blog/a">A</a> <a href="/blog/b">B</a> <a href="/blog/c">C</a> <a href="/blog/d">D</a> <a href="/account">Account</a> <a href="/logout">Log out</a> <a href="/report.pdf">PDF</a>';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  appendFileSync('requests.log', req.method + ' ' + url.pathname + '\\n');
  const signedIn = (req.headers.cookie || '').includes('session=ok');
  const send = (body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
  if (url.pathname === '/') return send(page('<h1>Home</h1>' + nav));
  if (url.pathname === '/about') return send(page('<h1>About</h1><div style="width:600px;background:#eee">A banner with a fixed width</div>'));
  if (url.pathname.startsWith('/blog/')) return send(page('<h1>Post</h1><p>Words.</p>'));
  if (url.pathname === '/account') return signedIn ? send(page('<h1>Your account</h1>')) : send('', 302, { location: '/login' });
  if (url.pathname === '/login' && req.method === 'POST') return send('', 303, { location: '/account', 'set-cookie': 'session=ok; Path=/; HttpOnly' });
  if (url.pathname === '/login') return send(page('<h1>Log in</h1><form method="post"><input name="user"><input type="password" name="password"><button>Log in</button></form>'));
  if (url.pathname === '/logout') return send(page('<h1>Logged out</h1>'), 200, { 'set-cookie': 'session=; Path=/; Max-Age=0' });
  send(page('<h1>Not found</h1>'), 404);
});
server.listen(0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
`;

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'breakhound-app-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'made-up-app', scripts: { dev: 'node server.mjs' } }),
  );
  writeFileSync(join(root, 'server.mjs'), SERVER);
  mkdirSync(join(root, '.git'));
  return root;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const QUICK = { widths: { min: 320, max: 800 }, screenshots: false };

describe('scanning a whole app with no config', () => {
  it('starts the dev server, follows links, spots the login wall and stops the server', async () => {
    const root = makeProject();
    const { result } = await runScan({
      targets: [],
      config: QUICK,
      cwd: root,
      version: 'test',
      quiet: true,
    });

    const byRoute = Object.fromEntries(result.routes.map((r) => [r.route, r.status]));
    expect(byRoute).toEqual({
      '/': 'scanned',
      '/about': 'scanned',
      '/blog/a': 'scanned',
      '/blog/b': 'scanned',
      '/blog/c': 'scanned',
      '/account': 'login',
    });
    const about = result.routes.find((r) => r.route === '/about');
    expect(about?.issues.map((i) => i.detector)).toContain('page-overflow');

    const requests = readFileSync(join(root, 'requests.log'), 'utf8');
    expect(requests).not.toMatch(/\/logout|report\.pdf|\/blog\/d/);
    const port = Number(new URL(result.project.baseUrl ?? '').port);
    expect(await portOpen(port)).toBe(false);
  });

  it('logs in once and scans the page behind the login afterwards', async () => {
    const root = makeProject();
    await runLogin(
      root,
      {},
      {
        path: '/login',
        quiet: true,
        automate: async (page) => {
          await page.fill('input[name=user]', 'test-user');
          await page.fill('input[type=password]', 'test-only-password');
          await Promise.all([page.waitForURL('**/account'), page.click('button')]);
        },
      },
    );
    expect(existsSync(join(root, AUTH_FILE))).toBe(true);
    // The folder ignores itself, so the saved login can't be committed.
    expect(readFileSync(join(root, '.breakhound/.gitignore'), 'utf8')).toMatch(/^\*$/m);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);

    const { result } = await runScan({
      targets: ['/account'],
      config: QUICK,
      cwd: root,
      version: 'test',
      quiet: true,
    });
    expect(result.routes.map((r) => [r.route, r.status])).toEqual([['/account', 'scanned']]);
  });

  it('uses a sample for a dynamic route and says which ones had none', async () => {
    const root = makeProject();
    const { result } = await runScan({
      targets: [],
      config: {
        ...QUICK,
        routes: ['/', '/blog/[slug]', '/users/[id]', '/docs/[page]'],
        samples: { '/docs/[page]': '/about' },
      },
      cwd: root,
      version: 'test',
      quiet: true,
    });
    const byRoute = Object.fromEntries(
      result.routes.map((r) => [
        r.route,
        `${r.status} ${r.url ? new URL(r.url).pathname : ''}`.trim(),
      ]),
    );
    expect(byRoute).toEqual({
      '/': 'scanned /',
      '/blog/[slug]': 'scanned /blog/a',
      '/docs/[page]': 'scanned /about',
      '/users/[id]': 'skipped',
    });
  });

  it('scans an app mounted under a base path, and ignores links outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breakhound-base-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
    );
    writeFileSync(join(root, 'vite.config.js'), "export default { base: '/docs/' };");
    writeFileSync(
      join(root, 'server.mjs'),
      `import { createServer } from 'node:http';
const page = (b) => '<!doctype html><meta name="viewport" content="width=device-width"><main>' + b + '</main>';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/\\/$/, '');
  res.writeHead(path.startsWith('/docs') ? 200 : 404, { 'content-type': 'text/html' });
  if (path === '/docs') return res.end(page('<h1>Docs</h1><a href="/docs/install">Install</a> <a href="/elsewhere">Elsewhere</a>'));
  if (path === '/docs/install') return res.end(page('<h1>Install</h1>'));
  res.end(page('<h1>Not found</h1>'));
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/docs/'));`,
    );
    const { result } = await runScan({
      targets: [],
      config: QUICK,
      cwd: root,
      version: 'test',
      quiet: true,
    });
    expect(result.routes.map((r) => [r.route, r.status, new URL(r.url).pathname])).toEqual([
      ['/', 'scanned', '/docs/'],
      ['/install', 'scanned', '/docs/install'],
    ]);
  });

  it('follows links from the home page even when include leaves it out', async () => {
    const root = makeProject();
    const { result } = await runScan({
      targets: [],
      config: { ...QUICK, include: ['/blog/**'] },
      cwd: root,
      version: 'test',
      quiet: true,
    });
    expect(result.routes.map((r) => r.route)).toEqual(['/blog/a', '/blog/b', '/blog/c']);
  });

  it('scans an app that routes by hash, one page per route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breakhound-hash-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
    );
    // A tiny hash router: the page shows whatever route is after "#/".
    const html = `<!doctype html><meta name="viewport" content="width=device-width"><main id="app"></main><script>
const pages = { '/': '<h1>Home</h1><a href="#/about">About</a> <a href="#/wide">Wide</a> <a href="#/logout">Log out</a>',
  '/about': '<h1>About</h1><p>Plain words.</p>', '/wide': '<h1>Wide</h1><div style="width:700px;background:#ddd">wide</div>' };
function show() { if (!location.hash.startsWith('#/')) { location.replace('#/'); return; }
  document.getElementById('app').innerHTML = pages[location.hash.slice(1)] || '<h1>Not found</h1>'; }
addEventListener('hashchange', show); show();
</script>`;
    writeFileSync(
      join(root, 'server.mjs'),
      `import { createServer } from 'node:http';
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(${JSON.stringify(html)}); });
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/'));`,
    );
    const { result } = await runScan({
      targets: [],
      config: QUICK,
      cwd: root,
      version: 'test',
      quiet: true,
    });
    const byRoute = Object.fromEntries(result.routes.map((r) => [r.route, new URL(r.url).hash]));
    expect(byRoute).toEqual({ '/': '#/', '/about': '#/about', '/wide': '#/wide' });
    const wide = result.routes.find((r) => r.route === '/wide');
    expect(wide?.issues.map((i) => i.detector)).toContain('page-overflow');
  });
});
