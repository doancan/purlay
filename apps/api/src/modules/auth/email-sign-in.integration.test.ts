/**
 * Asking for a sign-in link, against the real database (#81, D-138): what is sent for each kind of
 * address — a link for one no account has and for an email account's, a word to use GitHub for a
 * GitHub account's, nothing for an erased one — the token kept only as its digest, fifteen minutes,
 * five messages an hour of either kind, and the address read as it is stored. Then using one: shown
 * without being spent, spent once, within its fifteen minutes, making the account the first time and
 * never opening a GitHub account or an erased one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { tokenDigest } from '../../platform/tokens';
import { aRecordingLogger } from '../../testing/doubles';
import { aUserRow } from '../../testing/users';
import { attempt } from '../../testing/attempt';
import {
  SIGN_IN_LINKS_PER_HOUR,
  SIGN_IN_LINK_TTL_MS,
  consumeSignInLink,
  previewSignInLink,
  requestSignInLink,
} from './email-sign-in';
import { resolveIdentity } from './identity';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const APP = 'https://purlay.test';

const ask = (
  db: Transaction,
  email: string,
  locale: 'en' | 'tr' = 'en',
  at: Date = NOW,
): ReturnType<typeof requestSignInLink> =>
  requestSignInLink(
    db,
    { clock: fixedClock(at), appUrl: APP, log: aRecordingLogger().log },
    { email, locale },
  );

const tokenIn = (text: string): string => {
  const match = /\/sign-in\/email#([0-9a-f]{64})/.exec(text);
  if (match?.[1] === undefined) throw new Error('no link in the message');
  return match[1];
};

describe('integration: asking for a sign-in link', () => {
  test('an address no account has gets a link; only its digest is kept, for fifteen minutes', async () => {
    await withRollback(async (db) => {
      const sent = await ask(db, 'Newcomer@Example.TEST ');
      expect(sent?.to).toBe('newcomer@example.test');
      const token = tokenIn(sent?.text ?? '');
      expect(sent?.html).toContain(`href="${APP}/sign-in/email#${token}"`);
      const rows = await db
        .selectFrom('email_sign_ins')
        .selectAll()
        .where('email', '=', 'newcomer@example.test')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        email: 'newcomer@example.test',
        kind: 'link',
        token_hash: await tokenDigest(token),
        used_at: null,
      });
      expect(new Date(rows[0]?.expires_at ?? 0).getTime() - NOW.getTime()).toBe(
        SIGN_IN_LINK_TTL_MS,
      );
      expect(JSON.stringify(rows)).not.toContain(token);
    });
  });

  test('an invitation the asker holds rides in the link’s fragment, after the token', async () => {
    await withRollback(async (db) => {
      const invitation = 'c'.repeat(64);
      const sent = await requestSignInLink(
        db,
        { clock: fixedClock(NOW), appUrl: APP, log: aRecordingLogger().log },
        { email: 'invited@example.test', locale: 'en', invitation },
      );
      const token = tokenIn(sent?.text ?? '');
      expect(sent?.text).toContain(`${APP}/sign-in/email#${token}.${invitation}\n`);
      expect(sent?.html).toContain(`href="${APP}/sign-in/email#${token}.${invitation}"`);
    });
  });

  test('an email account’s address gets a link; a GitHub account’s, a word to use GitHub and no link', async () => {
    await withRollback(async (db) => {
      const viaGitHub = await aUserRow(db, 'octo');
      await db
        .updateTable('users')
        .set({ github_id: 4_242_424 })
        .where('id', '=', viaGitHub.userId)
        .execute();
      const address = (
        await db
          .selectFrom('users')
          .select('email')
          .where('id', '=', viaGitHub.userId)
          .executeTakeFirstOrThrow()
      ).email;
      const told = await ask(db, address, 'tr');
      expect(told?.subject).toBe('Purlay’a giriş');
      expect(told?.text).toContain('GitHub');
      expect(told?.text).not.toContain('/sign-in/email#');
      const kinds = await db
        .selectFrom('email_sign_ins')
        .select(['kind', 'token_hash'])
        .where('email', '=', address)
        .execute();
      expect(kinds).toEqual([{ kind: 'github', token_hash: null }]);
      // The words name the button the sign-in screen shows, in the language asked in.
      expect(told?.text).toContain('“GitHub ile devam et”');
      expect((await ask(db, address, 'en'))?.text).toContain('“Continue with GitHub”');

      // An account made by email: no github id.
      await db
        .insertInto('users')
        .values({ email: 'mailed@example.test', username: 'mailed', display_name: 'mailed' })
        .execute();
      expect(tokenIn((await ask(db, 'mailed@example.test'))?.text ?? '')).toHaveLength(64);
    });
  });

  test('an erased account is told nothing and gets nothing', async () => {
    await withRollback(async (db) => {
      await db
        .insertInto('users')
        .values({
          email: 'gone@example.test',
          username: 'gone',
          display_name: 'gone',
          deleted_at: NOW,
        })
        .execute();
      expect(await ask(db, 'gone@example.test')).toBeNull();
      expect(
        await db
          .selectFrom('email_sign_ins')
          .selectAll()
          .where('email', '=', 'gone@example.test')
          .execute(),
      ).toEqual([]);
    });
  });

  test('five messages an hour for an address, of either kind: the fifth is sent, the sixth is not', async () => {
    await withRollback(async (db) => {
      for (let n = 1; n < SIGN_IN_LINKS_PER_HOUR; n += 1) {
        expect(await ask(db, 'busy@example.test')).not.toBeNull();
      }
      expect(await ask(db, 'busy@example.test')).not.toBeNull();
      expect(await ask(db, 'busy@example.test')).toBeNull();
      // Another address is its own count; and an hour later the first may ask again.
      expect(await ask(db, 'other@example.test')).not.toBeNull();
      expect(
        await ask(db, 'busy@example.test', 'en', new Date(NOW.getTime() + 60 * 60_000 + 1)),
      ).not.toBeNull();
    });
  });

  test('not one address, or one with a line break in it, is refused before anything is written', async () => {
    await withRollback(async (db) => {
      for (const email of [
        'nobody',
        'a@b',
        'a b@example.test',
        'a@example.test\r\nBcc: x@y.z',
        // What a mail library reads as the one mailbox inside it: each would be its own count.
        'x<victim@example.test>',
        'victim@example.test>',
        'a(c)victim@example.test',
        'x:victim@example.test;',
        'victim@example.test,foo',
        '=?utf-8?q?x?=<victim@example.test>',
        '"x"@example.test',
        '.a@example.test',
        'a..b@example.test',
        'a@-example.test',
        'ü@example.test',
      ]) {
        expect(await attempt(db, () => ask(db, email))).toBe('VALIDATION_FAILED');
      }
      // Every row this test could have written is at its instant.
      expect(
        await db.selectFrom('email_sign_ins').selectAll().where('created_at', '=', NOW).execute(),
      ).toEqual([]);
    });
  });

  test('an address as people write them is taken', async () => {
    await withRollback(async (db) => {
      for (const email of ['a.b+notes@mail.example.test', "o'brien@example.test", 'x_1@a-b.test']) {
        expect(await ask(db, email)).not.toBeNull();
      }
    });
  });
});

describe('integration: using a sign-in link', () => {
  const at = (ms: number): ReturnType<typeof fixedClock> =>
    fixedClock(new Date(NOW.getTime() + ms));

  test('shown first by its address; used once, it makes the account an address no account has', async () => {
    await withRollback(async (db) => {
      const token = tokenIn((await ask(db, 'Ada.Lovelace+notes@Example.TEST'))?.text ?? '');
      expect(await previewSignInLink(db, at(1), token)).toEqual({
        email: 'ada.lovelace+notes@example.test',
      });
      const { userId, created } = await consumeSignInLink(db, at(2), token);
      expect(created).toBe(true);
      const user = await db
        .selectFrom('users')
        .select(['email', 'username', 'display_name', 'github_id'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user).toEqual({
        email: 'ada.lovelace+notes@example.test',
        username: 'ada-lovelace-notes',
        display_name: 'ada-lovelace-notes',
        github_id: null,
      });
      // Spent: neither shown nor used again.
      expect(await attempt(db, () => previewSignInLink(db, at(3), token))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
      expect(await attempt(db, () => consumeSignInLink(db, at(3), token))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
      // The next link to the address signs into the account it made.
      const again = tokenIn((await ask(db, 'ada.lovelace+notes@example.test'))?.text ?? '');
      expect(await consumeSignInLink(db, at(4), again)).toEqual({ userId, created: false });
    });
  });

  test('a link opens for fifteen minutes: a millisecond before, and not at the minute', async () => {
    await withRollback(async (db) => {
      const early = tokenIn((await ask(db, 'early@example.test'))?.text ?? '');
      expect((await consumeSignInLink(db, at(SIGN_IN_LINK_TTL_MS - 1), early)).created).toBe(true);
      const late = tokenIn((await ask(db, 'late@example.test'))?.text ?? '');
      expect(await attempt(db, () => consumeSignInLink(db, at(SIGN_IN_LINK_TTL_MS), late))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
      // An unknown token: the same answer.
      expect(await attempt(db, () => consumeSignInLink(db, at(0), 'f'.repeat(64)))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
    });
  });

  test('a link never opens an account that became a GitHub account’s', async () => {
    await withRollback(async (db) => {
      const token = tokenIn((await ask(db, 'turned@example.test'))?.text ?? '');
      // Between the link and its use, the address became a GitHub account's.
      await db
        .insertInto('users')
        .values({
          email: 'turned@example.test',
          username: 'turned',
          display_name: 'turned',
          github_id: '777',
        })
        .execute();
      expect(await attempt(db, () => consumeSignInLink(db, at(1), token))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
    });
  });

  test('a link never opens an account erased since it was sent', async () => {
    await withRollback(async (db) => {
      const token = tokenIn((await ask(db, 'erased@example.test'))?.text ?? '');
      await db
        .insertInto('users')
        .values({
          email: 'erased@example.test',
          username: 'erased',
          display_name: 'erased',
          deleted_at: NOW,
        })
        .execute();
      expect(await attempt(db, () => consumeSignInLink(db, at(1), token))).toBe(
        'SIGN_IN_LINK_NOT_FOUND',
      );
    });
  });

  test('an address with nothing to name gets a random name, not one of a hundred numbered ones', async () => {
    await withRollback(async (db) => {
      const token = tokenIn((await ask(db, 'here@example.test'))?.text ?? '');
      const { userId } = await consumeSignInLink(db, at(1), token);
      const made = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(made.username).toMatch(/^user-[0-9a-f]{6}$/);
    });
  });

  test('GitHub sign-in on an email account’s address is refused, not linked (D-138 §3)', async () => {
    await withRollback(async (db) => {
      const token = tokenIn((await ask(db, 'mine@example.test'))?.text ?? '');
      await consumeSignInLink(db, at(1), token);
      expect(
        await attempt(db, () =>
          resolveIdentity(
            db,
            at(2),
            { id: 99_001, login: 'somebody', name: null, avatarUrl: null },
            [{ email: 'mine@example.test', primary: true, verified: true }],
          ),
        ),
      ).toBe('ACCOUNT_EMAIL_CONFLICT');
    });
  });
});
