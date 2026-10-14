import { describe, expect, it } from 'vitest';
import { parsePattern, RouteQueue } from '../src/index';

const BASE = 'http://localhost:3000';

/** A queue with these routes, after a scanned page linked to `links`, filled as at the end of a scan. */
function filled(
  routes: string[],
  links: string[],
  config: { samples?: Record<string, string>; params?: Record<string, string> } = {},
) {
  const queue = new RouteQueue(BASE, config.samples ?? {}, null, false, config.params ?? {});
  for (const r of routes) queue.addPattern(parsePattern(r));
  queue.addLinks(links);
  queue.fillWaiting();
  const urls = Object.fromEntries(queue.jobs.map((j) => [j.route, j.url.replace(BASE, '')]));
  return { urls, missing: Object.fromEntries(queue.missing) };
}

describe('dynamic routes no link fits', () => {
  it('reuse the values of a parent route a real link was found for', () => {
    const { urls, missing } = filled(
      ['/cohorts/[slug]', '/cohorts/[slug]/settings', '/cohorts/[slug]/members/[memberId]'],
      ['/cohorts/css-101'],
    );
    expect(urls).toEqual({
      '/cohorts/[slug]': '/cohorts/css-101',
      '/cohorts/[slug]/settings': '/cohorts/css-101/settings',
    });
    // Only what nothing gave a value is asked for.
    expect(missing).toEqual({ '/cohorts/[slug]/members/[memberId]': ['memberId'] });
  });

  it('take the values params names, however deep the route', () => {
    const { urls, missing } = filled(
      ['/cohorts/[slug]', '/cohorts/[slug]/submissions/assignment/[submissionId]'],
      ['/cohorts/css-101'],
      { params: { submissionId: '42' } },
    );
    expect(urls['/cohorts/[slug]/submissions/assignment/[submissionId]']).toBe(
      '/cohorts/css-101/submissions/assignment/42',
    );
    expect(missing).toEqual({});
    // With no link at all, params can give every value.
    expect(
      filled(['/cohorts/[slug]/submissions/assignment/[submissionId]'], [], {
        params: { slug: '1', submissionId: '1' },
      }).urls,
    ).toEqual({
      '/cohorts/[slug]/submissions/assignment/[submissionId]':
        '/cohorts/1/submissions/assignment/1',
    });
  });

  it('prefer a real link, then a sample, over values they are filled from', () => {
    const { urls } = filled(
      ['/cohorts/[slug]', '/cohorts/[slug]/settings', '/cohorts/[slug]/lessons/[lesson]'],
      ['/cohorts/css-101', '/cohorts/js-201/settings'],
      {
        samples: { '/cohorts/[slug]/lessons/[lesson]': '/cohorts/html-1/lessons/intro' },
        params: { slug: 'from-params', lesson: 'from-params' },
      },
    );
    expect(urls).toEqual({
      '/cohorts/[slug]/lessons/[lesson]': '/cohorts/html-1/lessons/intro',
      '/cohorts/[slug]': '/cohorts/css-101',
      '/cohorts/[slug]/settings': '/cohorts/js-201/settings',
    });
  });

  it("don't borrow a parameter of the same name from another part of the app", () => {
    const { urls, missing } = filled(['/users/[id]', '/orders/[id]'], ['/users/5']);
    expect(urls).toEqual({ '/users/[id]': '/users/5' });
    expect(missing).toEqual({ '/orders/[id]': ['id'] });
  });

  it('fill catch-alls and parameters inside a segment from params, and leave out optional ones', () => {
    const { urls } = filled(['/docs/[...path]', '/posts/post-[id]', '/[[lang]]/about/[team]'], [], {
      params: { path: 'guides/setup', id: '7', team: 'design' },
    });
    expect(urls).toEqual({
      '/docs/[...path]': '/docs/guides/setup',
      '/posts/post-[id]': '/posts/post-7',
      '/[[lang]]/about/[team]': '/about/design',
    });
  });

  it('learn from a sample given as a full URL by its path, not its address', () => {
    const { urls } = filled(['/[team]/[project]/[env]', '/[team]/[project]/[env]/logs'], [], {
      samples: { '/[team]/[project]/[env]': 'https://staging.example.com/acme/site/prod' },
    });
    expect(urls['/[team]/[project]/[env]/logs']).toBe('/acme/site/prod/logs');
  });

  it('keep a $ in a value as it is', () => {
    const { urls } = filled(['/deals/deal-[code]'], [], { params: { code: 'save-$&' } });
    expect(urls['/deals/deal-[code]']).toBe('/deals/deal-save-$&');
  });
});
