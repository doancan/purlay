/**
 * One sentence per cause: every code a request can fail with lands on a sentence that tells
 * the person what to do, in both languages, and a session that ended is noticed.
 */
import { describe, expect, test } from 'bun:test';
import { ErrorCode } from '@purlay/types';
import { en } from '../i18n/catalogue/en';
import { tr } from '../i18n/catalogue/tr';
import { installDom } from '../testing/dom';
import { renderApp } from '../testing/render';
import { ApiError } from './errors';
import { codeOf, failureKey, useDescribeFailure, type FailureCode } from './failure';
import { keys } from './keys';

installDom();

const everyCode = (): FailureCode[] => [
  ...ErrorCode.anyOf.map((member) => member.const),
  'NETWORK',
  'MALFORMED',
  'TIMEOUT',
  'UNKNOWN',
];

describe('which sentence says a failure', () => {
  test('every code the API can send, and the three the client adds, has one that exists in both languages', () => {
    for (const code of everyCode()) {
      const key = failureKey(code);
      expect(en[key], code).toBeDefined();
      expect(tr[key], code).toBeDefined();
    }
  });

  test.each([
    ['NETWORK', 'failure.network'],
    ['TIMEOUT', 'failure.network'],
    ['UNAUTHENTICATED', 'failure.session'],
    ['CHANNEL_NOT_FOUND', 'failure.gone'],
    ['FORBIDDEN', 'failure.gone'],
    ['MESSAGE_NOT_FOUND', 'failure.gone'],
    ['RATE_LIMITED', 'failure.slow'],
    ['VALIDATION_FAILED', 'failure.refused'],
    ['THREAD_NOT_RESOLVABLE', 'failure.refused'],
    ['GITHUB_FEED_EXISTS', 'failure.githubFeedExists'],
    ['GITHUB_FEEDS_LIMIT', 'failure.githubFeedsLimit'],
    ['GITHUB_FEED_NOT_FOUND', 'failure.gone'],
    ['INTERNAL', 'failure.generic'],
    ['DATABASE_UNAVAILABLE', 'failure.generic'],
    ['MALFORMED', 'failure.generic'],
    ['UNKNOWN', 'failure.generic'],
  ] as const)('%s says %s', (code, key) => {
    expect(failureKey(code)).toBe(key);
  });

  test('anything that is not an ApiError is a failure nobody described', () => {
    expect(codeOf(new ApiError(404, 'CHANNEL_NOT_FOUND', 'gone'))).toBe('CHANNEL_NOT_FOUND');
    expect(codeOf(new Error('boom'))).toBe('UNKNOWN');
    expect(codeOf('a string')).toBe('UNKNOWN');
  });
});

describe('what a screen says', () => {
  const said = async (
    error: unknown,
    locale: 'en' | 'tr' = 'en',
  ): Promise<{ text: string; invalidated: boolean }> => {
    let describe: (error: unknown) => string = () => '';
    const Probe = (): null => {
      describe = useDescribeFailure();
      return null;
    };
    const view = await renderApp(<Probe />, { locale });
    view.world.client.setQueryData(keys.me, { user: null });
    const text = describe(error);
    return {
      text,
      invalidated: view.world.client.getQueryState(keys.me)?.isInvalidated === true,
    };
  };

  test('in the language the person reads', async () => {
    expect((await said(new ApiError(0, 'NETWORK', 'x'))).text).toBe(en['failure.network']);
    expect((await said(new ApiError(0, 'NETWORK', 'x'), 'tr')).text).toBe(tr['failure.network']);
  });

  test("never the server's own English message", async () => {
    const { text } = await said(new ApiError(500, 'INTERNAL', 'select * from secrets failed'));
    expect(text).not.toContain('secrets');
    expect(text).toBe(en['failure.generic']);
  });

  test('a session that ended asks for the identity again, so the gate takes over; nothing else does', async () => {
    expect((await said(new ApiError(401, 'UNAUTHENTICATED', 'no'))).invalidated).toBe(true);
    expect((await said(new ApiError(404, 'CHANNEL_NOT_FOUND', 'no'))).invalidated).toBe(false);
    expect((await said(new Error('boom'))).invalidated).toBe(false);
  });
});
