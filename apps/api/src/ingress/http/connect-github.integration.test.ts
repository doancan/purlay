/**
 * Connecting GitHub to an account made by email (D-176), driven through real requests against a real
 * database, with GitHub a double.
 *
 * This is the account-takeover surface D-5 and D-138 §3 named, so each way it could be turned is a
 * case here and each must fail closed, saying why: a connect replayed after sign-out, one begun in
 * session A and finished in a browser signed in as B, a forged, tampered or expired state, a GitHub
 * account another Purlay account signs in with, an account that has GitHub already, a start a page on
 * another site could make, and an email account trying to come by a GitHub account it does not
 * control. And the point of it all: once connected, a GitHub sign-in is a sign-in to that account.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { ConnectGitHubOutcome } from '@purlay/types';
import { createApp } from './app';
import { SESSION_COOKIE, STATE_COOKIE } from '../../platform/cookies';
import { fixedClock, type Clock } from '../../platform/clock';
import {
  NOW,
  aGitHubAccount,
  aMovableClock,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { GitHubUnavailableError, type GitHubClient } from '../../modules/auth/github';
import { issueConnectState } from '../../modules/auth/state';
import { consumeSignInLink, requestSignInLink } from '../../modules/auth/email-sign-in';
import type { Logger } from '../../platform/logging';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const WORKSPACE = 'acme-eng';
const OTHER_KEY = 'YW5vdGhlci1kZXZlbG9wbWVudC1vbmx5LWtleS0zMi1ieQ==';

/** A GitHub id no row in a developer's database holds. */
const aGitHubId = (): number => 700_000_000 + Math.floor(Math.random() * 99_999_999);

interface World {
  readonly db: Executor;
  readonly github: GitHubClient;
  readonly clock: Clock;
  readonly log: Logger;
}

const appOf = ({ db, github, clock, log }: World): ReturnType<typeof createApp> =>
  createApp(testDependencies({ database: db, github, clock, log }));

const aWorld = (db: Executor, github: GitHubClient, overrides: Partial<World> = {}): World => ({
  db,
  github,
  clock: fixedClock(NOW),
  log: testDependencies().log,
  ...overrides,
});

/** The GitHub account the person authorizes on GitHub's screen. */
const aGitHub = (id: number, login = `gh-${String(id)}`): GitHubClient =>
  aGitHubAccount(
    { id, login, name: 'Ada on GitHub', avatarUrl: `https://avatars.example.test/${String(id)}` },
    [{ email: `gh-${String(id)}@example.test`, primary: true, verified: true }],
  );

/** GitHub, failing every call with this error. */
const aFailingGitHub = (error: Error): GitHubClient => ({
  exchangeCode: async (): Promise<string> => await Promise.reject(error),
  profile: async (): Promise<never> => await Promise.reject(error),
  emails: async (): Promise<never> => await Promise.reject(error),
});

/** A GitHub the test must not reach: a refused connect spends no code. */
const aGitHubThatMustNotBeCalled = (): GitHubClient =>
  aFailingGitHub(new Error('GitHub was called for a connect that should have been refused first'));

interface Started {
  readonly response: Response;
  /** The `name=value` the browser sends back. */
  readonly stateCookie: string;
  readonly state: string;
}

/** Connect GitHub, pressed on the Sessions & account page: a same-origin JSON `POST`. */
const start = async (world: World, as: SignedInUser, workspace = WORKSPACE): Promise<Started> => {
  const response = await appOf(world).handle(
    new Request(`${ORIGIN}/api/me/github/connect`, {
      method: 'POST',
      headers: {
        cookie: as.cookie,
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspace }),
    }),
  );
  const stateCookie =
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${STATE_COOKIE}=`))
      ?.split(';')[0] ?? '';
  const body = response.ok ? ((await response.json()) as { location: string }) : undefined;
  const state = body === undefined ? '' : (new URL(body.location).searchParams.get('state') ?? '');
  return { response, stateCookie, state };
};

/** GitHub sends the browser back: whatever cookies that browser holds now, and the query. */
const callback = async (
  world: World,
  cookies: readonly string[],
  query: string,
): Promise<Response> =>
  await appOf(world).handle(
    new Request(`${ORIGIN}/auth/github/callback?${query}`, {
      headers: { cookie: cookies.filter((cookie) => cookie !== '').join('; ') },
    }),
  );

/** The connect, finished in the browser that began it. */
const finish = async (
  world: World,
  started: Started,
  as: SignedInUser,
  code = 'a-valid-code',
): Promise<Response> =>
  await callback(world, [started.stateCookie, as.cookie], `code=${code}&state=${started.state}`);

/** Back on the page it began on, saying how it went, the state spent and no session issued. */
const expectBack = (response: Response, outcome: ConnectGitHubOutcome): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(
    `${ORIGIN}/w/${WORKSPACE}/settings/account?github=${outcome}`,
  );
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
  expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
};

const identityOf = async (
  db: Executor,
  userId: string,
): Promise<{
  github_id: string | null;
  github_login: string | null;
  github_connected_at: Date | null;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}> =>
  await db
    .selectFrom('users')
    .select([
      'github_id',
      'github_login',
      'github_connected_at',
      'email',
      'username',
      'display_name',
      'avatar_url',
    ])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

const expectNotConnected = async (db: Executor, user: SignedInUser): Promise<void> => {
  expect(await identityOf(db, user.userId)).toMatchObject({
    github_id: null,
    github_login: null,
    github_connected_at: null,
  });
};

/** An account GitHub made: what a GitHub sign-in leaves behind. */
const aGitHubMadeAccount = async (
  db: Executor,
  githubId: number,
  login: string,
): Promise<SignedInUser> => {
  const user = await aSignedInUser(db, fixedClock(NOW), 'gh-made');
  await db
    .updateTable('users')
    .set({ github_id: String(githubId), github_login: login })
    .where('id', '=', user.userId)
    .execute();
  return user;
};

describe('integration: connecting GitHub to an account made by email (D-176)', () => {
  test('pressing Connect answers where to go, with a state bound to this browser by a host-only cookie', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'connect-ada');
      const started = await start(aWorld(db, aGitHubThatMustNotBeCalled()), ada);

      expect(started.response.status).toBe(200);
      const cookie = started.response.headers
        .getSetCookie()
        .find((each) => each.startsWith(`${STATE_COOKIE}=`));
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=600');
      expect(started.state).toMatch(/^[0-9a-f]{32}$/);
      // A connect's cookie, not a sign-in's: the callback tells them apart by what was signed.
      expect(started.stateCookie.startsWith(`${STATE_COOKIE}=connect.`)).toBe(true);
    });
  });

  test('connecting sets the GitHub account and nothing else of the person, and comes back saying so', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const githubId = aGitHubId();
      const world = aWorld(db, aGitHub(githubId, 'Ada-Lovelace'), { log });
      const ada = await aSignedInUser(db, world.clock, 'connect-ada');
      const before = await identityOf(db, ada.userId);

      const response = await finish(world, await start(world, ada), ada);

      expectBack(response, 'connected');
      expect(await identityOf(db, ada.userId)).toEqual({
        ...before,
        github_id: String(githubId),
        github_login: 'Ada-Lovelace',
        github_connected_at: NOW,
        // The picture is GitHub's (D-11); the address, the username and the name stay hers.
        avatar_url: `https://avatars.example.test/${String(githubId)}`,
      });
      expect(
        lines.find((line) => line['msg'] === 'GitHub connected to an account made by email'),
      ).toMatchObject({
        level: 'info',
        userId: ada.userId,
      });

      const mine = await appOf(world).handle(
        new Request(`${ORIGIN}/api/me/sign-in`, { headers: { cookie: ada.cookie } }),
      );
      expect(await mine.json()).toEqual({
        email: before.email,
        emailLinks: true,
        github: { login: 'Ada-Lovelace' },
      });
    });
  });

  test('once connected, a GitHub sign-in signs into that account, and its email link still does', async () => {
    await withRollback(async (db) => {
      const githubId = aGitHubId();
      const world = aWorld(db, aGitHub(githubId, 'ada-gh'));
      const ada = await aSignedInUser(db, world.clock, 'connect-ada');
      const before = await identityOf(db, ada.userId);
      expectBack(await finish(world, await start(world, ada), ada), 'connected');

      // GitHub's sign-in, in a new browser: the account is found by its GitHub id.
      const app = appOf(world);
      const begun = await app.handle(new Request(`${ORIGIN}/auth/github`));
      const state = new URL(begun.headers.get('location') ?? '').searchParams.get('state') ?? '';
      const signedIn = await app.handle(
        new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
          headers: { cookie: (begun.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
        }),
      );
      expect(signedIn.headers.get('location')).toBe(ORIGIN);
      const session = signedIn.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0];
      expect(session).toBeDefined();
      const me = await app.handle(
        new Request(`${ORIGIN}/api/me`, { headers: { cookie: session ?? '' } }),
      );
      expect(((await me.json()) as { user: { id: string } }).user.id).toBe(ada.userId);
      // A sign-in does not rename an account GitHub did not make (D-176): hers, as she had them.
      expect(await identityOf(db, ada.userId)).toMatchObject({
        email: before.email,
        username: before.username,
        display_name: before.display_name,
      });

      // Connecting added a way in and took none away (D-138 §2 for an account made by email).
      const mail = await requestSignInLink(
        db,
        { clock: world.clock, appUrl: ORIGIN, log: world.log },
        { email: before.email, locale: 'en' },
      );
      const token = /#([0-9a-f]{64})/.exec(mail?.text ?? '')?.[1] ?? '';
      expect(token).toHaveLength(64);
      expect((await consumeSignInLink(db, world.clock, token)).userId).toBe(ada.userId);
    });
  });

  test('the login is held as a sign-in holds it: taken from an account that still has it (D-169 §2)', async () => {
    await withRollback(async (db) => {
      const githubId = aGitHubId();
      const world = aWorld(db, aGitHub(githubId, 'Renamed-Away'));
      const stale = await aGitHubMadeAccount(db, aGitHubId(), 'renamed-away');
      const ada = await aSignedInUser(db, world.clock, 'connect-ada');

      expectBack(await finish(world, await start(world, ada), ada), 'connected');

      expect((await identityOf(db, ada.userId)).github_login).toBe('Renamed-Away');
      expect((await identityOf(db, stale.userId)).github_login).toBeNull();
    });
  });

  describe('fails closed', () => {
    test('replayed after signing out: the session that asked is gone, so nothing is connected', async () => {
      await withRollback(async (db) => {
        const ada = await aSignedInUser(db, fixedClock(NOW), 'connect-ada');
        const begin = aWorld(db, aGitHub(aGitHubId()));
        const started = await start(begin, ada);
        const out = await appOf(begin).handle(
          new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { cookie: ada.cookie } }),
        );
        expect(out.status).toBe(204);

        // GitHub is never asked: had the code been spent, this would read `failed`.
        const world = aWorld(db, aGitHubThatMustNotBeCalled());
        expectBack(await finish(world, started, ada), 'session');
        // And the browser that kept no session cookie at all is the same refusal.
        expectBack(
          await callback(world, [started.stateCookie], `code=a-valid-code&state=${started.state}`),
          'session',
        );
        await expectNotConnected(db, ada);
      });
    });

    test('begun as A, finished in a browser signed in as B: neither account is touched', async () => {
      await withRollback(async (db) => {
        const ada = await aSignedInUser(db, fixedClock(NOW), 'connect-ada');
        const bob = await aSignedInUser(db, fixedClock(NOW), 'connect-bob');
        const started = await start(aWorld(db, aGitHubThatMustNotBeCalled()), ada);

        const world = aWorld(db, aGitHubThatMustNotBeCalled());
        expectBack(await finish(world, started, bob), 'session');
        await expectNotConnected(db, ada);
        await expectNotConnected(db, bob);

        // And A's own second session is not the one that asked either.
        const adaElsewhere = await aSignedInUser(db, fixedClock(NOW), 'connect-ada2');
        await db
          .updateTable('sessions')
          .set({ user_id: ada.userId })
          .where('id', '=', adaElsewhere.sessionId)
          .execute();
        expectBack(await finish(world, started, adaElsewhere), 'session');
        await expectNotConnected(db, ada);
      });
    });

    test('a state the browser did not get back: expired, tampered, or this server never signed', async () => {
      await withRollback(async (db) => {
        const clock = aMovableClock();
        const ada = await aSignedInUser(db, clock, 'connect-ada');
        const bob = await aSignedInUser(db, clock, 'connect-bob');
        const world = aWorld(db, aGitHubThatMustNotBeCalled(), { clock });
        const started = await start(world, ada);

        // Not the state GitHub was given.
        const flipped = `${started.state.slice(0, -1)}${started.state.endsWith('0') ? '1' : '0'}`;
        expectBack(
          await callback(
            world,
            [started.stateCookie, ada.cookie],
            `code=a-valid-code&state=${flipped}`,
          ),
          'expired',
        );

        // Past its ten minutes.
        clock.advance(10 * 60_000 + 1);
        expectBack(await finish(world, started, ada), 'expired');

        // Rewritten to name bob: no longer this server's signature, so not a connect at all — and not a
        // sign-in either, since it is no sign-in's cookie. Nobody is signed in or connected.
        const [name, value] = started.stateCookie.split('=') as [string, string];
        const tampered = `${name}=${value.replace(ada.userId, bob.userId)}`;
        expect(tampered).not.toBe(started.stateCookie);
        const rewritten = await callback(
          world,
          [tampered, bob.cookie],
          `code=a-valid-code&state=${started.state}`,
        );
        expect(rewritten.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);

        // Signed with another root secret: a forgery, whatever it says.
        const forged = await issueConnectState(OTHER_KEY, clock, {
          userId: bob.userId,
          sessionId: bob.sessionId,
          workspace: WORKSPACE,
        });
        const answer = await callback(
          world,
          [`${STATE_COOKIE}=${forged.cookieValue}`, bob.cookie],
          `code=a-valid-code&state=${forged.state}`,
        );
        expect(answer.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
        expect(
          answer.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
        ).toBe(false);

        await expectNotConnected(db, ada);
        await expectNotConnected(db, bob);
      });
    });

    test('a GitHub account another Purlay account signs in with is refused, never merged', async () => {
      await withRollback(async (db) => {
        const githubId = aGitHubId();
        const owner = await aGitHubMadeAccount(db, githubId, 'the-owner');
        const ownerBefore = await identityOf(db, owner.userId);
        const world = aWorld(db, aGitHub(githubId, 'the-owner'));
        const ada = await aSignedInUser(db, world.clock, 'connect-ada');

        expectBack(await finish(world, await start(world, ada), ada), 'taken');

        await expectNotConnected(db, ada);
        expect(await identityOf(db, owner.userId)).toEqual(ownerBefore);
      });
    });

    test('an account that has GitHub already: refused when pressed, and when it arrived meanwhile', async () => {
      await withRollback(async (db) => {
        const world = aWorld(db, aGitHub(aGitHubId()));
        const made = await aGitHubMadeAccount(db, aGitHubId(), 'made-with-github');
        const refused = await start(world, made);
        expect(refused.response.status).toBe(409);
        expect(await refused.response.json()).toMatchObject({
          error: { code: 'GITHUB_ALREADY_CONNECTED' },
        });
        expect(refused.stateCookie).toBe('');

        // Connected in another tab between pressing and GitHub's answer.
        const ada = await aSignedInUser(db, world.clock, 'connect-ada');
        const started = await start(world, ada);
        const first = aGitHubId();
        await db
          .updateTable('users')
          .set({ github_id: String(first), github_connected_at: NOW })
          .where('id', '=', ada.userId)
          .execute();
        expectBack(await finish(world, started, ada), 'already');
        expect((await identityOf(db, ada.userId)).github_id).toBe(String(first));
      });
    });

    test('a start another site could make is refused before anything is issued', async () => {
      await withRollback(async (db) => {
        const ada = await aSignedInUser(db, fixedClock(NOW), 'connect-ada');
        const app = appOf(aWorld(db, aGitHubThatMustNotBeCalled()));
        const attempts: readonly [string, RequestInit, number][] = [
          // A page elsewhere posting with the person's cookie.
          [
            'cross-site fetch',
            {
              method: 'POST',
              headers: {
                cookie: ada.cookie,
                origin: 'https://evil.example',
                'content-type': 'application/json',
              },
              body: JSON.stringify({ workspace: WORKSPACE }),
            },
            403,
          ],
          // A form, which a page elsewhere can post without a preflight.
          [
            'cross-site form',
            {
              method: 'POST',
              headers: {
                cookie: ada.cookie,
                'sec-fetch-site': 'cross-site',
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: `workspace=${WORKSPACE}`,
            },
            403,
          ],
          [
            'form with no origin',
            {
              method: 'POST',
              headers: { cookie: ada.cookie, 'content-type': 'text/plain' },
              body: JSON.stringify({ workspace: WORKSPACE }),
            },
            415,
          ],
          // A link or an image: there is no GET that starts one.
          ['a link', { method: 'GET', headers: { cookie: ada.cookie } }, 404],
        ];
        for (const [what, init, status] of attempts) {
          const response = await app.handle(new Request(`${ORIGIN}/api/me/github/connect`, init));
          expect({ what, status: response.status }).toEqual({ what, status });
          expect({
            what,
            stateCookie: response.headers
              .getSetCookie()
              .some((c) => c.startsWith(`${STATE_COOKIE}=`)),
          }).toEqual({ what, stateCookie: false });
        }
        // And without a session, there is nobody to connect.
        const anonymous = await app.handle(
          new Request(`${ORIGIN}/api/me/github/connect`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: WORKSPACE }),
          }),
        );
        expect(anonymous.status).toBe(401);
        // Nor a workspace that is not a slug, which is where the person is sent back to.
        const elsewhere = await app.handle(
          new Request(`${ORIGIN}/api/me/github/connect`, {
            method: 'POST',
            headers: { cookie: ada.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: '//evil.example' }),
          }),
        );
        expect(elsewhere.status).toBe(400);
        await expectNotConnected(db, ada);
      });
    });

    test('an email account cannot come by a GitHub account that shares its address', async () => {
      await withRollback(async (db) => {
        // The pre-hijack of D-138 §3: an email account holds the address a GitHub account verifies.
        const githubId = aGitHubId();
        const holder = await aSignedInUser(db, fixedClock(NOW), 'connect-holder');
        const victim = aGitHubAccount(
          { id: githubId, login: 'victim', name: null, avatarUrl: null },
          [{ email: holder.email, primary: true, verified: true }],
        );
        const world = aWorld(db, victim);
        // The victim's own GitHub sign-in is refused, and links nothing (D-138 §3).
        const app = appOf(world);
        const begun = await app.handle(new Request(`${ORIGIN}/auth/github`));
        const state = new URL(begun.headers.get('location') ?? '').searchParams.get('state') ?? '';
        const refused = await app.handle(
          new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
            headers: { cookie: (begun.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
          }),
        );
        expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=email-taken`);
        await expectNotConnected(db, holder);

        // The holder's connect, finished with the victim's grant in a browser that did not begin it:
        // no connect cookie, so it is a sign-in, refused as above — never a connect.
        const started = await start(world, holder);
        const grant = await callback(
          world,
          [holder.cookie],
          `code=a-valid-code&state=${started.state}`,
        );
        expect(grant.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
        await expectNotConnected(db, holder);

        // What is connected is only ever the account GitHub vouches for: words in the address that
        // name another are not read.
        const other = aGitHubId();
        const named = await callback(
          aWorld(db, aGitHub(other, 'holders-own')),
          [started.stateCookie, holder.cookie],
          `code=a-valid-code&state=${started.state}&github_id=${String(githubId)}&login=victim`,
        );
        expectBack(named, 'connected');
        expect((await identityOf(db, holder.userId)).github_id).toBe(String(other));
      });
    });

    test('cancelling on GitHub, or GitHub failing, connects nothing and says which', async () => {
      await withRollback(async (db) => {
        const ada = await aSignedInUser(db, fixedClock(NOW), 'connect-ada');
        const world = aWorld(db, aGitHubThatMustNotBeCalled());
        const started = await start(world, ada);
        expectBack(
          await callback(
            world,
            [started.stateCookie, ada.cookie],
            `error=access_denied&state=${started.state}`,
          ),
          'cancelled',
        );

        const { log, lines } = aRecordingLogger();
        const down = aWorld(
          db,
          aFailingGitHub(new GitHubUnavailableError('GitHub could not be reached')),
          { log },
        );
        expectBack(await finish(down, await start(down, ada), ada), 'github-unavailable');
        expect(lines.find((line) => line['msg'] === 'GitHub failed a connect')).toMatchObject({
          level: 'warn',
        });
        await expectNotConnected(db, ada);
      });
    });
  });

  test('the ways an account GitHub made signs in: GitHub, and no email link (D-138 §2)', async () => {
    await withRollback(async (db) => {
      const made = await aGitHubMadeAccount(db, aGitHubId(), 'made-with-github');
      const answer = await appOf(aWorld(db, aGitHubThatMustNotBeCalled())).handle(
        new Request(`${ORIGIN}/api/me/sign-in`, { headers: { cookie: made.cookie } }),
      );
      expect(await answer.json()).toEqual({
        email: made.email,
        emailLinks: false,
        github: { login: 'made-with-github' },
      });
    });
  });
});
