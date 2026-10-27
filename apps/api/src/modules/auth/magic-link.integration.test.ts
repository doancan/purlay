/**
 * What `magic-link.ts` decides, against the real database and with the sign-in library stood in for
 * where the point is what is asked of it (D-138, D-179):
 *
 * - **The answer comes before anything about the address is read** (D-138 §1, §6): a request is
 *   counted and answered, and only then is the account looked up and a link made — so how long the
 *   answer takes says nothing about whether the address has an account.
 * - **A link for an account never proven is refused before the library is asked** (D-179 §4): the
 *   first lock, alone, without the library's own hooks behind it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { tokenDigest } from '../../platform/tokens';
import { aRecordingLogger, aRecordingOutbox, NOW } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import type { SignInLinks } from './better-auth';
import { attempt } from '../../testing/attempt';
import { consumeSignInLink, requestSignInLink } from './magic-link';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const anAccount = async (db: Executor, email: string, verified: boolean): Promise<string> =>
  (
    await db
      .insertInto('users')
      .values({
        email,
        username: email.slice(0, email.indexOf('@')),
        display_name: 'x',
        email_verified: verified,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

describe('integration: asking for a link, as decided', () => {
  test('the request is answered before the account is read or any link made', async () => {
    await withRollback(async (db) => {
      await anAccount(db, 'known@example.test', true);
      const outbox = aRecordingOutbox();
      const links = aTestAuth(db, {
        mailer: outbox,
        settings: { github: undefined, oidc: undefined, signUp: 'invite-only' },
      }).signInLinks;
      if (links === undefined) throw new Error('sign-in by link is not on');
      // What is left for after the answer, held here and not run until the test says.
      const later: (() => Promise<void>)[] = [];
      await requestSignInLink(
        {
          database: db,
          clock: fixedClock(NOW),
          log: aRecordingLogger().log,
          appUrl: 'https://purlay.test',
          links,
          later: (work) => {
            later.push(work);
          },
        },
        { email: 'known@example.test', locale: 'en' },
        '203.0.113.7',
      );
      // Answered: nothing about the address has happened yet.
      expect(later).toHaveLength(1);
      expect(outbox.posted).toEqual([]);
      expect(
        await db
          .selectFrom('verifications')
          .select('id')
          .where('value', 'like', '%known@%')
          .execute(),
      ).toEqual([]);
      for (const work of later) await work();
      expect(outbox.posted.map((message) => message.to)).toEqual(['known@example.test']);
    });
  });
});

describe('integration: a link asked for by the native application (D-191)', () => {
  const challenge = 'a'.repeat(43);
  const state = 'b'.repeat(22);

  /** The one letter a request makes, once what was left for after the answer has run. */
  const letterFor = async (
    db: Executor,
    request: { readonly native?: { readonly challenge: string; readonly state: string } },
  ): Promise<string> => {
    await anAccount(db, 'native@example.test', true);
    const outbox = aRecordingOutbox();
    const links = aTestAuth(db, {
      mailer: outbox,
      settings: { github: undefined, oidc: undefined, signUp: 'invite-only' },
    }).signInLinks;
    if (links === undefined) throw new Error('sign-in by link is not on');
    const later: (() => Promise<void>)[] = [];
    await requestSignInLink(
      {
        database: db,
        clock: fixedClock(NOW),
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        links,
        later: (work) => {
          later.push(work);
        },
      },
      { email: 'native@example.test', locale: 'en', ...request },
      '203.0.113.8',
    );
    for (const work of later) await work();
    return JSON.stringify(outbox.posted);
  };

  const link = (letter: string): string =>
    /https:\/\/purlay\.test\/sign-in\/email#[0-9a-zA-Z._~-]+/.exec(letter)?.[0] ?? '';

  test('carries the challenge and the state in the link’s fragment, after the token, so no server log sees them', async () => {
    await withRollback(async (db) => {
      const url = link(await letterFor(db, { native: { challenge, state } }));
      expect(url).toMatch(new RegExp(`#[0-9a-f]{64}~${challenge}~${state}$`));
    });
  });

  test('carries nothing of the kind for a link nobody asked for the native application with', async () => {
    await withRollback(async (db) => {
      const url = link(await letterFor(db, {}));
      expect(url).toMatch(/#[0-9a-f]{64}$/);
      expect(url).not.toContain('~');
    });
  });

  // The pair is the application's own word and is written into a mail the person opens: only what the
  // contract's patterns allow reaches it, whatever got past the edge.
  test.each([
    ['a challenge that is too short', { challenge: 'x'.repeat(42), state }],
    ['a challenge that is not base64url', { challenge: `${'x'.repeat(42)}&`, state }],
    ['a state that ends the address', { challenge, state: `${'a'.repeat(16)}&x=` }],
    ['a state that is too short', { challenge, state: 'a'.repeat(15) }],
  ])('drops %s, and sends the link as any other', async (_name, pair) => {
    await withRollback(async (db) => {
      const url = link(await letterFor(db, { native: pair }));
      expect(url).toMatch(/#[0-9a-f]{64}$/);
    });
  });
});

describe('integration: spending a link, as decided', () => {
  /** A library that records whether it was asked to spend, and spends nothing. */
  const aLibraryThatRecords = (): SignInLinks & { readonly asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      signUp: 'open',
      outbox: aRecordingOutbox(),
      issue: () => Promise.resolve(),
      spend: (token): Promise<readonly string[]> => {
        asked.push(token);
        return Promise.resolve(['a-session-cookie']);
      },
    };
  };

  /** A link's row as the library keeps it: the token's digest, base64url, and the address as JSON. */
  const aLinkRow = async (db: Executor, token: string, email: string): Promise<void> => {
    await db
      .insertInto('verifications')
      .values({
        identifier: `magic-link:${Buffer.from(await tokenDigest(token), 'hex').toString('base64url')}`,
        value: JSON.stringify({ type: 'magic-link', email }),
        expires_at: new Date(Date.now() + 15 * 60_000),
      })
      .execute();
  };

  test('a link to an account never proven is refused, and the library is never asked to spend it', async () => {
    await withRollback(async (db) => {
      const library = aLibraryThatRecords();
      const [unproven, proven] = ['a'.repeat(64), 'b'.repeat(64)];
      await anAccount(db, 'unproven@example.test', false);
      await anAccount(db, 'proven@example.test', true);
      await aLinkRow(db, unproven, 'unproven@example.test');
      await aLinkRow(db, proven, 'proven@example.test');
      const dependencies = { database: db, clock: fixedClock(NOW), links: library };
      expect(
        await attempt(db, () => consumeSignInLink(dependencies, unproven, new Headers())),
      ).toBe('SIGN_IN_LINK_NOT_FOUND');
      expect(library.asked).toEqual([]);
      // The control: a proven account's link is handed to the library.
      expect(await consumeSignInLink(dependencies, proven, new Headers())).toEqual({
        setCookie: ['a-session-cookie'],
      });
      expect(library.asked).toEqual([proven]);
    });
  });
});

describe('integration: an account single sign-on is linked to is signed into by it alone (D-200 §6)', () => {
  /** The library's own row for a provider's account, as a sign-in through it leaves it. */
  const linkedToSso = async (db: Executor, userId: string): Promise<void> => {
    await db
      .insertInto('accounts')
      .values({
        user_id: userId,
        provider_id: 'oidc',
        account_id: `https://idp.example.test|sub-${userId}`,
      })
      .execute();
  };

  /** What asking for a link to the address sends, once what is left for after the answer has run. */
  const posted = async (db: Executor, email: string): Promise<readonly string[]> => {
    const outbox = aRecordingOutbox();
    const links = aTestAuth(db, {
      mailer: outbox,
      settings: { github: undefined, oidc: undefined, signUp: 'invite-only' },
    }).signInLinks;
    if (links === undefined) throw new Error('sign-in by link is not on');
    const later: (() => Promise<void>)[] = [];
    await requestSignInLink(
      {
        database: db,
        clock: fixedClock(NOW),
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        links,
        later: (work) => {
          later.push(work);
        },
      },
      { email, locale: 'en' },
      '203.0.113.9',
    );
    for (const work of later) await work();
    return outbox.posted.map((message) => message.to);
  };

  test('is sent no link, while the same account without the provider is', async () => {
    await withRollback(async (db) => {
      const sso = await anAccount(db, 'sso@example.test', true);
      await anAccount(db, 'plain@example.test', true);
      await linkedToSso(db, sso);
      expect(await posted(db, 'sso@example.test')).toEqual([]);
      expect(await posted(db, 'plain@example.test')).toEqual(['plain@example.test']);
    });
  });

  test('a link sent before the account was linked is refused when spent, and the library never asked', async () => {
    await withRollback(async (db) => {
      const library: SignInLinks & { readonly asked: string[] } = {
        asked: [],
        signUp: 'open',
        outbox: aRecordingOutbox(),
        issue: () => Promise.resolve(),
        spend: (token): Promise<readonly string[]> => {
          library.asked.push(token);
          return Promise.resolve(['a-session-cookie']);
        },
      };
      const token = 'c'.repeat(64);
      const id = await anAccount(db, 'late@example.test', true);
      await db
        .insertInto('verifications')
        .values({
          identifier: `magic-link:${Buffer.from(await tokenDigest(token), 'hex').toString('base64url')}`,
          value: JSON.stringify({ type: 'magic-link', email: 'late@example.test' }),
          expires_at: new Date(Date.now() + 15 * 60_000),
        })
        .execute();
      await linkedToSso(db, id);
      const dependencies = { database: db, clock: fixedClock(NOW), links: library };
      expect(await attempt(db, () => consumeSignInLink(dependencies, token, new Headers()))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
      expect(library.asked).toEqual([]);
    });
  });
});
