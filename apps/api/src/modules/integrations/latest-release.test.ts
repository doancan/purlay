/**
 * The newest release, as the server asks GitHub for it (D-248): what is accepted, what is refused as `null`, and
 * how long each answer is kept — with a fetch and a clock the test holds, so no wait is real.
 */
import { describe, expect, test } from 'bun:test';
import { HOUR_MS, type Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { GitHubAppFetch } from './github-app-api';
import { latestReleaseCheck } from './latest-release';

const START = new Date('2026-11-01T12:00:00.000Z');
const API = 'https://api.github.example';

const GOOD = {
  tag_name: 'v1.2.3',
  html_url: 'https://github.com/doancan/purlay/releases/tag/v1.2.3',
  published_at: '2026-10-30T08:00:00Z',
  draft: false,
  prerelease: false,
  body: 'ignored',
};

/** A clock that moves when the test says so. */
const clockAt = (): { clock: Clock; advance: (ms: number) => void } => {
  let now = START.getTime();
  return {
    clock: { now: () => new Date(now) },
    advance: (ms): void => {
      now += ms;
    },
  };
};

const logs = (): { log: Logger; lines: { message: string; fields: unknown }[] } => {
  const lines: { message: string; fields: unknown }[] = [];
  const note = (message: string, fields?: unknown): void => {
    lines.push({ message, fields });
  };
  const log: Logger = { debug: note, info: note, warn: note, error: note, child: () => log };
  return { log, lines };
};

type Answer = () => Response | Promise<Response>;

const world = (
  answers: Answer[],
  options: { enabled?: boolean } = {},
): {
  readonly check: ReturnType<typeof latestReleaseCheck>;
  readonly calls: { url: string; redirect: string; method: string }[];
  readonly advance: (ms: number) => void;
  readonly lines: ReturnType<typeof logs>['lines'];
} => {
  const calls: { url: string; redirect: string; method: string }[] = [];
  const { clock, advance } = clockAt();
  const { log, lines } = logs();
  const fetch: GitHubAppFetch = async (url, init) => {
    calls.push({ url, redirect: init.redirect, method: init.method });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer === undefined) throw new Error('no answer prepared');
    return await answer();
  };
  const check = latestReleaseCheck({
    enabled: options.enabled ?? true,
    apiUrl: API,
    fetch,
    clock,
    log,
  });
  return { check, calls, advance, lines };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A release whose page is exactly the page of its tag, so only the tag itself can be what is refused. */
const tagged = (tag: string): Response =>
  json({
    ...GOOD,
    tag_name: tag,
    html_url: `https://github.com/doancan/purlay/releases/tag/${tag}`,
  });

const GOOD_ANSWER = {
  latest: {
    version: '1.2.3',
    url: 'https://github.com/doancan/purlay/releases/tag/v1.2.3',
    publishedAt: '2026-10-30T08:00:00.000Z',
  },
};

describe('the newest release', () => {
  test('is asked for at the repository, without following a redirect, and read as version, page and date', async () => {
    const { check, calls } = world([(): Response => json(GOOD)]);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toEqual([
      { url: `${API}/repos/doancan/purlay/releases/latest`, redirect: 'manual', method: 'GET' },
    ]);
  });

  test('is never asked for when the operator turned the check off', async () => {
    const { check, calls } = world([(): Response => json(GOOD)], { enabled: false });
    expect(await check.latest()).toEqual({ latest: null });
    expect(await check.latest()).toEqual({ latest: null });
    expect(calls).toEqual([]);
  });

  test('is kept six hours: asked again within them it is not asked of GitHub, after them it is', async () => {
    const newer = {
      ...GOOD,
      tag_name: 'v1.3.0',
      html_url: 'https://github.com/doancan/purlay/releases/tag/v1.3.0',
    };
    const { check, calls, advance } = world([
      (): Response => json(GOOD),
      (): Response => json(newer),
    ]);
    await check.latest();
    advance(6 * HOUR_MS - 1);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(1);
    advance(1);
    expect((await check.latest()).latest?.version).toBe('1.3.0');
    expect(calls).toHaveLength(2);
  });

  test('two callers arriving together share one call', async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { check, calls } = world([(): Promise<Response> => held]);
    const first = check.latest();
    const second = check.latest();
    release(json(GOOD));
    expect(await Promise.all([first, second])).toEqual([GOOD_ANSWER, GOOD_ANSWER]);
    expect(calls).toHaveLength(1);
  });

  test('a call that fails lets the next one try again, not the one in flight', async () => {
    const { check, calls, advance } = world([
      (): Response => json({}, 500),
      (): Response => json(GOOD),
    ]);
    expect(await Promise.all([check.latest(), check.latest()])).toEqual([
      { latest: null },
      { latest: null },
    ]);
    expect(calls).toHaveLength(1);
    advance(10 * 60 * 1000);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(2);
  });
});

describe('what GitHub can answer instead', () => {
  const refused: [string, Answer][] = [
    ['a server error', (): Response => json({}, 503)],
    ['a rate limit', (): Response => json({}, 403, { 'x-ratelimit-remaining': '0' })],
    ['a plain 403', (): Response => json({}, 403)],
    ['a missing repository', (): Response => json({ message: 'Not Found' }, 404)],
    [
      'a redirect',
      (): Response =>
        new Response('', { status: 301, headers: { location: 'https://evil.test/' } }),
    ],
    ['a body that is not JSON', (): Response => new Response('<html>', { status: 200 })],
    ['an array', (): Response => json([GOOD])],
    ['a release without a tag', (): Response => json({ ...GOOD, tag_name: undefined })],
    ['a pre-release tag', (): Response => json({ ...GOOD, tag_name: 'v1.0.0-rc1' })],
    ['a tag without its v', (): Response => json({ ...GOOD, tag_name: '1.2.3' })],
    ['a tag with a line break after it', (): Response => json({ ...GOOD, tag_name: 'v1.2.3\n' })],
    [
      'a page on another site',
      (): Response => json({ ...GOOD, html_url: 'https://evil.test/v1.2.3' }),
    ],
    [
      'a page that only looks like GitHub',
      (): Response => json({ ...GOOD, html_url: 'https://github.com.evil.test/x' }),
    ],
    [
      'a page over plain http',
      (): Response => json({ ...GOOD, html_url: 'http://github.com/doancan/purlay' }),
    ],
    ['a page that is a script', (): Response => json({ ...GOOD, html_url: 'javascript:alert(1)' })],
    ['a date that is not one', (): Response => json({ ...GOOD, published_at: 'yesterday' })],
    ['a release that is a draft', (): Response => json({ ...GOOD, draft: true })],
    ['a release marked as a pre-release', (): Response => json({ ...GOOD, prerelease: true })],
    [
      'another repository’s page for the same tag',
      (): Response =>
        json({ ...GOOD, html_url: 'https://github.com/someone/else/releases/tag/v1.2.3' }),
    ],
    [
      'this repository’s page for another tag',
      (): Response =>
        json({ ...GOOD, html_url: 'https://github.com/doancan/purlay/releases/tag/v1.2.4' }),
    ],
    [
      'a page that is this repository’s but not a tag’s',
      (): Response => json({ ...GOOD, html_url: 'https://github.com/doancan/purlay' }),
    ],
    [
      'a page with something after it',
      (): Response => json({ ...GOOD, html_url: `${GOOD.html_url}?x=1` }),
    ],
    [
      'a page of over three hundred characters',
      (): Response => json({ ...GOOD, html_url: `${GOOD.html_url}/${'a'.repeat(300)}` }),
    ],
    ['a pre-release tag whose own page is given', (): Response => tagged('v1.0.0-rc1')],
    ['a tag without its v, with its own page', (): Response => tagged('1.2.3')],
    ['a tag with a line break after it, with its own page', (): Response => tagged('v1.2.3\n')],
    [
      'a tag of sixty-five characters that is three numbers behind a v, with its own page',
      (): Response => tagged(`v1.2.${'3'.repeat(60)}`),
    ],
    [
      'no answer',
      (): Response => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
  ];

  for (const [name, answer] of refused) {
    test(`${name} is null, and says so in the log without a body`, async () => {
      const { check, lines } = world([answer]);
      expect(await check.latest()).toEqual({ latest: null });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toBe('the release check failed');
      expect(JSON.stringify(lines)).not.toContain('evil.test/v1');
    });
  }

  test('a failure is kept ten minutes: not asked again within them, asked after them', async () => {
    const { check, calls, advance } = world([
      (): Response => json({}, 500),
      (): Response => json(GOOD),
    ]);
    await check.latest();
    advance(10 * 60 * 1000 - 1);
    expect(await check.latest()).toEqual({ latest: null });
    expect(calls).toHaveLength(1);
    advance(1);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(2);
  });

  test('a limit GitHub names is waited out, no less than a failure and no more than an hour', async () => {
    const MINUTE = 60 * 1000;
    const longer = world([
      (): Response => json({}, 429, { 'retry-after': '1800' }),
      (): Response => json(GOOD),
    ]);
    await longer.check.latest();
    longer.advance(30 * MINUTE - 1);
    expect(await longer.check.latest()).toEqual({ latest: null });
    expect(longer.calls).toHaveLength(1);
    longer.advance(1);
    expect(await longer.check.latest()).toEqual(GOOD_ANSWER);

    const capped = world([
      (): Response => json({}, 429, { 'retry-after': '86400' }),
      (): Response => json(GOOD),
    ]);
    await capped.check.latest();
    capped.advance(60 * MINUTE - 1);
    expect(capped.calls).toHaveLength(1);
    await capped.check.latest();
    expect(capped.calls).toHaveLength(1);
    capped.advance(1);
    expect(await capped.check.latest()).toEqual(GOOD_ANSWER);

    const short = world([
      (): Response => json({}, 429, { 'retry-after': '30' }),
      (): Response => json(GOOD),
    ]);
    await short.check.latest();
    short.advance(10 * MINUTE);
    expect(await short.check.latest()).toEqual(GOOD_ANSWER);
  });

  test('a failure after a good answer does not take it back: it is served on, and asked again in ten minutes', async () => {
    const newer = {
      ...GOOD,
      tag_name: 'v1.3.0',
      html_url: 'https://github.com/doancan/purlay/releases/tag/v1.3.0',
    };
    const { check, calls, advance, lines } = world([
      (): Response => json(GOOD),
      (): Response => json({}, 503),
      (): Response => json(newer),
    ]);
    await check.latest();
    advance(6 * HOUR_MS);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(2);
    expect(lines).toHaveLength(1);
    advance(10 * 60 * 1000 - 1);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(2);
    advance(1);
    expect((await check.latest()).latest?.version).toBe('1.3.0');
    expect(calls).toHaveLength(3);
  });

  test('an unexpected failure is logged with what kind it was, and is null', async () => {
    const { check, lines } = world([
      (): Response => {
        const response = json(GOOD);
        Object.defineProperty(response, 'ok', {
          get: (): boolean => {
            throw new RangeError('boom');
          },
        });
        return response;
      },
    ]);
    expect(await check.latest()).toEqual({ latest: null });
    expect(lines[0]?.fields).toEqual({ reason: 'an unexpected failure', errorName: 'RangeError' });
  });

  test('no answer in time ends at the deadline, and the next call after the failure window asks again', async () => {
    const calls: number[] = [];
    const { clock, advance } = clockAt();
    const { log } = logs();
    const hanging: GitHubAppFetch = async (_url, init) => {
      calls.push(calls.length);
      if (calls.length > 1) return await Promise.resolve(json(GOOD));
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason as Error);
        });
      });
    };
    const check = latestReleaseCheck({
      enabled: true,
      apiUrl: API,
      fetch: hanging,
      clock,
      log,
      timeoutMs: 20,
    });
    // Two callers are waiting on the one call that never answers: both are released at the deadline.
    expect(await Promise.all([check.latest(), check.latest()])).toEqual([
      { latest: null },
      { latest: null },
    ]);
    expect(calls).toHaveLength(1);
    advance(10 * 60 * 1000);
    expect(await check.latest()).toEqual(GOOD_ANSWER);
    expect(calls).toHaveLength(2);
  });
});
