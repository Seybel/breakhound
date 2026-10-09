import { createHash as nodeHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHash } from '../src/shims/crypto';

describe('the SHA-1 the extension uses for issue ids', () => {
  it('matches Node, so the panel and the CLI give an issue the same id', () => {
    const inputs = [
      '',
      'a',
      '/pricing|page-overflow|div.banner|',
      'é ✓ 漢字',
      'x'.repeat(55),
      'y'.repeat(64),
      'z'.repeat(1000),
    ];
    for (const input of inputs) {
      expect(createHash('sha1').update(input).digest('hex')).toBe(
        nodeHash('sha1').update(input).digest('hex'),
      );
    }
  });
});
