import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Issue } from '@breakhound/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdits, parseEdits, pickFiles, runFix } from '../src/fix';
import { resolveModel } from '../src/model';
import { runScan } from '../src/scan';
import { CSS, git, makeRepo } from './repo';

function issue(selector: string, html: string, source: Issue['element']['source'] = null): Issue {
  return {
    id: 'x',
    fingerprint: 'x',
    detector: 'page-overflow',
    severity: 'error',
    title: 'Page scrolls horizontally',
    ranges: [{ from: 320, to: 399 }],
    worstAt: 320,
    element: { selector, path: '', html, text: null, source },
    evidence: {},
    styles: {},
  };
}

describe('edits from a model', () => {
  it('reads edits and ignores the talk around them', () => {
    const reply = `Made the banner fluid.

<edit file="./src/styles.css">
<search>
.banner { width: 600px }
</search>
<replace>
.banner { max-width: 600px }
</replace>
</edit>`;
    expect(parseEdits(reply)).toEqual([
      {
        file: 'src/styles.css',
        search: '.banner { width: 600px }',
        replace: '.banner { max-width: 600px }',
      },
    ]);
    expect(parseEdits('No idea, sorry.')).toEqual([]);
  });

  it('applies edits all or nothing, only to files it was shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'breakhound-edit-'));
    writeFileSync(
      join(dir, 'a.css'),
      '.a { width: 600px }  \n.b { color: red }\n.b { color: red }\n',
    );
    const allowed = new Set(['a.css']);
    // Trailing spaces in the file don't stop a match.
    const ok = applyEdits(
      dir,
      [{ file: 'a.css', search: '.a { width: 600px }', replace: '.a { max-width: 600px }' }],
      allowed,
    );
    expect('originals' in ok).toBe(true);
    expect(readFileSync(join(dir, 'a.css'), 'utf8')).toContain('.a { max-width: 600px }');

    const before = readFileSync(join(dir, 'a.css'), 'utf8');
    expect(
      applyEdits(dir, [{ file: 'a.css', search: '.b { color: red }', replace: '' }], allowed),
    ).toEqual({
      error: expect.stringMatching(/more than one place/),
    });
    expect(
      applyEdits(
        dir,
        [
          { file: 'a.css', search: '.a { max-width: 600px }', replace: '.a {}' },
          { file: 'a.css', search: 'not there', replace: '' },
        ],
        allowed,
      ),
    ).toEqual({ error: expect.stringMatching(/isn't in the file/) });
    expect(applyEdits(dir, [{ file: '../etc/hosts', search: 'x', replace: 'y' }], allowed)).toEqual(
      {
        error: expect.stringMatching(/wasn't one of the files/),
      },
    );
    expect(readFileSync(join(dir, 'a.css'), 'utf8')).toBe(before);
  });

  it('shows the source file first, then the files that mention the element', () => {
    const dir = mkdtempSync(join(tmpdir(), 'breakhound-pick-'));
    writeFileSync(
      join(dir, 'Banner.tsx'),
      'export const Banner = () => <div className="promo" />;\n',
    );
    writeFileSync(join(dir, 'styles.css'), '.promo { width: 600px }\n.promo-wide { }\n');
    writeFileSync(join(dir, 'other.css'), '.footer { }\n');
    const tracked = ['Banner.tsx', 'styles.css', 'other.css'];
    const located = issue('div.promo', '<div class="promo">', {
      file: 'Banner.tsx',
      line: 1,
      exact: true,
    });
    expect(pickFiles(dir, located, tracked).map((f) => f.path)).toEqual([
      'Banner.tsx',
      'styles.css',
    ]);
    expect(
      pickFiles(dir, issue('div.promo', '<div class="promo">'), tracked).map((f) => f.path),
    ).toEqual(['Banner.tsx', 'styles.css']);
  });
});

describe('choosing a model', () => {
  it('takes whichever key is set, Anthropic first', async () => {
    const both = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    expect((await resolveModel({ env: both })).provider).toBe('anthropic');
    expect((await resolveModel({ env: both, provider: 'openai', model: 'm' })).provider).toBe(
      'openai',
    );
    await expect(resolveModel({ env: { OPENAI_API_KEY: 'o' } })).rejects.toThrow(/--model/);
  });

  it('explains how to set one up when there is none', async () => {
    await expect(resolveModel({ env: { OLLAMA_HOST: 'http://127.0.0.1:9' } })).rejects.toThrow(
      /ANTHROPIC_API_KEY[\s\S]*ollama pull[\s\S]*breakhound prompt/,
    );
  });

  it('speaks the Anthropic messages API', async () => {
    let seen: { headers: IncomingMessage['headers']; body: Record<string, unknown> } | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'Hello' }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const model = await resolveModel({
        env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: base },
      });
      expect(await model.complete('Be brief.', 'Hi')).toBe('Hello');
      expect(seen).toMatchObject({
        headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
        body: {
          model: 'claude-opus-5-5',
          system: 'Be brief.',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });
    } finally {
      server.close();
    }
  });
});

describe('breakhound fix on a made-up app', () => {
  const root = makeRepo();
  let api: Server;
  let base: string;
  const prompts: string[] = [];

  beforeAll(async () => {
    writeFileSync(
      join(root, 'breakhound.config.json'),
      JSON.stringify({ widths: { min: 320, max: 800 }, screenshots: false }),
    );
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'Add breakhound config');
    // A model that fixes the banner properly, and only ever recolours the card.
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const prompt = JSON.parse(body).messages[1].content as string;
        prompts.push(prompt);
        const edit = prompt.includes('div.banner')
          ? { search: '.banner { width: 600px;', replace: '.banner { max-width: 600px;' }
          : { search: 'background: #ddd', replace: 'background: #ccc' };
        const content = `Done.\n<edit file="styles.css">\n<search>\n${edit.search}\n</search>\n<replace>\n${edit.replace}\n</replace>\n</edit>`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(() => api.close());

  it('commits the fix that holds and undoes the one that does not', async () => {
    const config = { widths: { min: 320, max: 800 }, screenshots: false };
    await runScan({ targets: [], config, cwd: root, version: 'test', quiet: true });
    const model = await resolveModel({
      env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base },
      provider: 'openai',
      model: 'mock',
    });
    const results = await runFix({
      cwd: root,
      config,
      version: 'test',
      quiet: true,
      model,
      severities: ['error', 'warning'],
    });

    expect(Object.fromEntries(results.map((r) => [r.routes.join(','), r.outcome]))).toEqual({
      '/about': 'not-fixed',
      '/pricing': 'fixed',
    });
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toBe(CSS.pricingFixed);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'log', '-1', '--format=%B')).toContain('Breakhound-Route: /pricing');
    // The second try was told why the first was undone.
    expect(prompts.some((p) => p.includes('undone because') && p.includes('still there'))).toBe(
      true,
    );
  }, 240_000);
});
