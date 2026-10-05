import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScan } from '../src/scan';
import { compareRoute } from '../src/verify';
import { parseVision } from '../src/vision';

describe('reading what a vision model saw', () => {
  it('keeps well-formed items at the widths it was shown', () => {
    const reply = `Here is what I found:
[
  {"width": 375, "problem": "Price wraps under the button", "text": "$19 a month", "fix": "Let the row wrap."},
  {"width": 500, "problem": "Not a width it was shown"},
  {"width": 768, "text": "no problem given"},
  {"width": 1280, "problem": "Hero image leaves a big empty gap"}
]`;
    expect(parseVision(reply, [375, 768, 1280])).toEqual([
      {
        width: 375,
        problem: 'Price wraps under the button',
        text: '$19 a month',
        fix: 'Let the row wrap.',
      },
      { width: 1280, problem: 'Hero image leaves a big empty gap' },
    ]);
    expect(parseVision('Looks fine to me.', [375])).toEqual([]);
    expect(parseVision('[not json]', [375])).toEqual([]);
  });

  it('is left out of verify, since an opinion cannot be checked again', () => {
    const vision = {
      id: 'v',
      fingerprint: 'v',
      detector: 'vision' as const,
      severity: 'info' as const,
      title: 'Looks cramped',
      ranges: [{ from: 375, to: 375 }],
      worstAt: 375,
      element: { selector: 'body', path: 'body', html: '<body>', text: null, source: null },
      evidence: {},
      styles: {},
    };
    expect(compareRoute('/', [vision], [])).toEqual({ fixed: [], failing: [], regressions: [] });
  });
});

describe('the vision check in a scan', () => {
  let api: Server;
  const requests: { content: { type: string; text?: string }[] }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push(JSON.parse(body).messages[0]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: '[{"width": 375, "problem": "Text sits too close to the header", "text": "Content", "fix": "Add space above the main content."}]',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_API_KEY = 'test';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    process.env = saved;
    api.close();
  });

  it('shows the model the page at each width and ties what it says to an element', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'breakhound-vision-'));
    const page = join(import.meta.dirname, '../../../fixtures/pages/bug-nav-wrap.html');
    const { result } = await runScan({
      targets: [page],
      config: { vision: true, outDir: join(cwd, 'out'), states: false },
      cwd,
      version: 'test',
      quiet: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(requests[0]?.content.at(-1)?.text).toMatch(/375px, 768px, 1280px/);

    const seen = result.routes[0]?.issues.filter((i) => i.detector === 'vision') ?? [];
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      severity: 'info',
      title: 'Text sits too close to the header',
      ranges: [{ from: 375, to: 375 }],
      element: { selector: 'p', text: 'Content' },
      suggestion: 'Add space above the main content.',
    });
    expect(seen[0]?.screenshot).toBeDefined();
  }, 120_000);
});
