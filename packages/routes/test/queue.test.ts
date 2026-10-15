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
      ['/users/[username]', '/users/[username]/settings', '/users/[username]/orders/[orderId]'],
      ['/users/jane'],
    );
    expect(urls).toEqual({
      '/users/[username]': '/users/jane',
      '/users/[username]/settings': '/users/jane/settings',
    });
    // Only what nothing gave a value is asked for.
    expect(missing).toEqual({ '/users/[username]/orders/[orderId]': ['orderId'] });
  });

  it('take the values params names, however deep the route', () => {
    const { urls, missing } = filled(
      ['/users/[username]', '/users/[username]/orders/history/[orderId]'],
      ['/users/jane'],
      { params: { orderId: '1001' } },
    );
    expect(urls['/users/[username]/orders/history/[orderId]']).toBe(
      '/users/jane/orders/history/1001',
    );
    expect(missing).toEqual({});
    // With no link at all, params can give every value.
    expect(
      filled(['/users/[username]/orders/history/[orderId]'], [], {
        params: { username: '1', orderId: '1' },
      }).urls,
    ).toEqual({
      '/users/[username]/orders/history/[orderId]': '/users/1/orders/history/1',
    });
  });

  it('prefer a real link, then a sample, over values they are filled from', () => {
    const { urls } = filled(
      ['/users/[username]', '/users/[username]/settings', '/users/[username]/orders/[orderId]'],
      ['/users/jane', '/users/sam/settings'],
      {
        samples: { '/users/[username]/orders/[orderId]': '/users/alex/orders/7' },
        params: { username: 'from-params', orderId: 'from-params' },
      },
    );
    expect(urls).toEqual({
      '/users/[username]/orders/[orderId]': '/users/alex/orders/7',
      '/users/[username]': '/users/jane',
      '/users/[username]/settings': '/users/sam/settings',
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
