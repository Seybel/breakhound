// A dev server for the example: serves this folder, nothing else. No dependencies.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site', import.meta.url));
const port = Number(process.env.PORT) || 4173;
const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
  const candidates = extname(file) ? [file] : [file, `${file}.html`];
  for (const candidate of candidates) {
    if (!candidate.startsWith(root)) break;
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { 'content-type': types[extname(candidate)] ?? 'text/plain' });
      res.end(body);
      return;
    } catch {}
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Not found</title><p>Not found</p>');
}).listen(port, () => console.log(`Local: http://localhost:${port}/`));
