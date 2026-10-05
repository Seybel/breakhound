import { describe, expect, it } from 'vitest';
import { parseContainerCondition } from '../src/fingerprint';

describe('container query conditions', () => {
  it('reads the name and thresholds', () => {
    expect(parseContainerCondition('card (min-width: 400px)')).toEqual([
      { name: 'card', value: 400, unit: 'px', after: false },
    ]);
    expect(parseContainerCondition('(max-inline-size: 30em)')).toEqual([
      { name: null, value: 30, unit: 'em', after: true },
    ]);
    expect(parseContainerCondition('(max-width: 30em)')).toEqual([
      { name: null, value: 30, unit: 'em', after: true },
    ]);
  });

  it('understands range syntax in both directions', () => {
    expect(parseContainerCondition('sidebar (width > 20rem)')).toEqual([
      { name: 'sidebar', value: 20, unit: 'rem', after: true },
    ]);
    expect(parseContainerCondition('(400px <= inline-size)')).toEqual([
      { name: null, value: 400, unit: 'px', after: false },
    ]);
    expect(parseContainerCondition('(width >= 300px) and (width < 600px)')).toEqual([
      { name: null, value: 300, unit: 'px', after: false },
      { name: null, value: 600, unit: 'px', after: false },
    ]);
  });

  it('skips style and negated queries for a name', () => {
    expect(parseContainerCondition('not (min-width: 400px)')[0]?.name).toBeNull();
    expect(parseContainerCondition('style(--compact: true)')).toEqual([]);
  });
});
