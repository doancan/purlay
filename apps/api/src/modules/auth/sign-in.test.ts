/**
 * The callback's refusal, before anything reaches GitHub or the database.
 *
 * A handshake is valid only with a state that checks out *and* a code to trade. A
 * callback with a good state and no code used to be a path the mutation run could
 * open (`code === undefined` dropped from the guard) without a test noticing: the
 * next line would then pass `undefined` to GitHub. Every refusal here has the same
 * answer, and none touches the database or GitHub: both are doubles that fail the
 * test if they are reached.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import {
  aDatabaseThatMustNotBeTouched,
  aGitHubAccount,
  aRecordingLogger,
  NOW,
  testConfig,
  type GitHubDouble,
} from '../../testing/doubles';
import { beginSignIn, completeSignIn, type CallbackInput } from './sign-in';

const clock = fixedClock(NOW);
const config = testConfig();

/** A GitHub that records being asked, so "never reached" is something the test can see. */
const aGitHubThatCounts = (): { github: GitHubDouble; asked: string[] } => {
  const asked: string[] = [];
  const account = aGitHubAccount({ id: 1, login: 'someone', name: null, avatarUrl: null }, [
    { email: 'someone@example.test', primary: true, verified: true },
  ]);
  return {
    asked,
    github: {
      ...account,
      exchangeCode: async (code: string): Promise<string> => {
        asked.push(code);
        return await account.exchangeCode(code);
      },
    },
  };
};

const attempt = async (
  input: Partial<CallbackInput>,
): Promise<{ code: string; asked: string[] }> => {
  const { stateCookieValue, redirectTo } = await beginSignIn({ config, clock });
  const state = new URL(redirectTo).searchParams.get('state') ?? '';
  const { github, asked } = aGitHubThatCounts();
  const outcome = await completeSignIn(
    {
      config,
      database: aDatabaseThatMustNotBeTouched(),
      clock,
      github,
      log: aRecordingLogger().log,
    },
    {
      code: 'a-valid-code',
      returnedState: state,
      stateCookie: stateCookieValue,
      userAgent: undefined,
      ipAddress: undefined,
      ...input,
    },
  ).then(
    () => 'signed in',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );
  return { code: outcome, asked };
};

describe('completing a sign-in', () => {
  test('a good state without a code is refused, and GitHub is never asked', async () => {
    const result = await attempt({ code: undefined });
    expect(result).toEqual({ code: 'OAUTH_STATE_INVALID', asked: [] });
  });

  test('a code without a good state is refused, and GitHub is never asked', async () => {
    const result = await attempt({ returnedState: 'not-the-state' });
    expect(result).toEqual({ code: 'OAUTH_STATE_INVALID', asked: [] });
  });

  test('a code and a state are what a handshake needs: both present, GitHub is asked', async () => {
    // The control: past the guard the double database is reached, which refuses —
    // so the refusals above are the guard's, not something that always fails.
    const result = await attempt({});
    expect(result.asked).toEqual(['a-valid-code']);
    expect(result.code).not.toBe('OAUTH_STATE_INVALID');
  });
});
