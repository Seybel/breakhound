import type { Issue } from '@breakhound/engine/core';
import { describe, expect, it } from 'vitest';
import { forServer } from '../src/agent';

const calendar = {
  id: 'calendar1',
  fingerprint: 'calendar|div.month|',
  detector: 'calendar',
  severity: 'error',
  title: "Calendar's 7 days don't fit side by side",
  ranges: [{ from: 320, to: 700 }],
  worstAt: 320,
  element: { selector: 'div.month', path: 'main > div', html: '<div>', text: null, source: null },
  evidence: { dayWidthPx: 40, checksInside: 'overlap:error squished-text:warning' },
  styles: {},
  suggestion: 'Let it scroll sideways inside its own box, or show the days as a list.',
} satisfies Issue;

describe("issues for a project's breakhound older than the extension", () => {
  it('send a check it knows as is', () => {
    expect(forServer(calendar, ['calendar', 'overlap'])).toBe(calendar);
  });

  it('send a calendar as a check found inside it, with its own title and fix', () => {
    const sent = forServer(calendar, ['page-overflow', 'squished-text']);
    expect(sent?.detector).toBe('squished-text');
    expect(sent?.title).toBe(calendar.title);
    expect(sent?.suggestion).toBe(calendar.suggestion);
    // The same calendar each time, so verify compares it with itself.
    expect(sent?.fingerprint).toBe(calendar.fingerprint);
  });

  it('leave out what it has no way to take', () => {
    expect(forServer(calendar, ['page-overflow'])).toBeNull();
  });
});
