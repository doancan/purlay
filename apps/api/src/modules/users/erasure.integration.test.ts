/**
 * Erasing an account against the real database (D-27 §2, D-139 §5–§6, I-11): every column that said who
 * they were, cleared — beside the control, what the team holds, still there under the anonymised row; a
 * later sign-in, by GitHub or by email, a new account; asked for with the username and a recent sign-in;
 * and a workspace never left without a live owner, nor one left so by an erased owner who still counts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { ERASURE_SIGN_IN_MINUTES, isErased, messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { aRecordingLogger, aRecordingOutbox } from '../../testing/doubles';
import { afterAnswer } from '../../platform/after-answer';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { SESSION_COOKIE } from '../../platform/cookies';
import { sessionFromHeaders } from '../auth/sessions';
import { recordGitHubSignIn } from '../auth/identity';
import type { SignInLinks } from '../auth/better-auth';
import { addressCounterKey, consumeSignInLink, requestSignInLink } from '../auth/magic-link';
import { addressAttemptsPrefix, countAttempt } from '../auth/password-attempts';
import { sendMessage } from '../messages/messages';
import { changeRole } from '../workspaces/members';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { eraseAccount } from './erasure';
import { issuePassport } from '../workspaces/invitation-passport';
import { tokenDigest } from '../../platform/tokens';
import { acceptInvitation, createInvitation } from '../workspaces/invitations';
import { inviterMailKey } from '../workspaces/invitation-mail';
import { aUserRow } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const MINUTE = 60_000;

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const owner = async (db: Transaction, room: Room, name: string): Promise<void> => {
  await db
    .updateTable('workspace_members')
    .set({ role: 'owner' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', member(room, name).userId)
    .execute();
};

/** A session for `name`, signed in `ago` milliseconds before now. */
const signedIn = async (
  db: Transaction,
  room: Room,
  name: string,
  ago = 0,
): Promise<{ userId: string; sessionId: string; cookie: string }> => {
  const { sessionId, token } = await aSession(
    db,
    fixedClock(new Date(NOW.getTime() - ago)),
    member(room, name).userId,
    30,
    { ipAddress: '203.0.113.7', userAgent: 'Firefox' },
  );
  return { userId: member(room, name).userId, sessionId, cookie: `${SESSION_COOKIE}=${token}` };
};

const emailOf = async (db: Transaction, userId: string): Promise<string> =>
  (await db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow())
    .email;

/** Better Auth's links over the test's transaction, on a server where anybody may sign up. */
const linksOver = (
  db: Transaction,
): SignInLinks & { readonly outbox: ReturnType<typeof aRecordingOutbox> } => {
  const outbox = aRecordingOutbox();
  const links = aTestAuth(db, {
    mailer: outbox,
    settings: { github: undefined, signUp: 'open' },
  }).signInLinks;
  if (links === undefined) throw new Error('sign-in by link is not on');
  return { ...links, outbox };
};

/** The library's link rows that name `email`, by the address in their value. */
const linkRowsFor = async (db: Transaction, emails: readonly string[]): Promise<string[]> =>
  (
    await db
      .selectFrom('verifications')
      .select('value')
      .where('identifier', 'like', 'magic-link:%')
      .execute()
  )
    .map((row) => (JSON.parse(row.value) as { email: string }).email)
    .filter((email) => emails.includes(email))
    .sort();

const erase = async (
  db: Transaction,
  caller: { userId: string; sessionId: string },
  confirm: string,
): ReturnType<typeof eraseAccount> => await eraseAccount(db, clock, caller, confirm);

describe('integration: erasing an account', () => {
  test('what said who they were is cleared; what the team holds stays under the anonymised row', async () => {
    await withRollback(async (db) => {
      // bob owns it (the first is the owner): ada is free to go.
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      const caller = await signedIn(db, room, 'ada');
      await db
        .updateTable('users')
        .set({
          github_id: '424242',
          github_login: 'Ada-On-GitHub',
          // Connected to an account made by email (D-176): when, is a trace of the identity too.
          github_connected_at: NOW,
          avatar_url: 'https://avatars.example.test/ada',
          title: 'Engineer',
          time_zone: 'Europe/Istanbul',
          status_text: 'here',
          last_seen_at: NOW,
        })
        .where('id', '=', ada.userId)
        .execute();
      const sent = await sendMessage(db, clock, ada.context, {
        id: messageId(NOW),
        content: `hello @${member(room, 'bob').username}`,
      });
      const bobsReply = await sendMessage(db, clock, member(room, 'bob').context, {
        id: messageId(new Date(NOW.getTime() + 1)),
        content: `@${ada.username} hi`,
      });
      await db
        .insertInto('reactions')
        .values({ message_id: sent.message.id, user_id: ada.userId, emoji: '👍' })
        .execute();
      await db
        .insertInto('saved_messages')
        .values({
          id: messageId(new Date(NOW.getTime() + 2)),
          user_id: ada.userId,
          message_id: bobsReply.message.id,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
        })
        .execute();
      // A thread let go (D-161): which conversations a person stopped hearing is theirs too.
      await db
        .insertInto('thread_follows')
        .values({
          user_id: ada.userId,
          message_id: sent.message.id,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          following: false,
        })
        .execute();
      await db
        .insertInto('push_subscriptions')
        .values({
          user_id: ada.userId,
          session_id: caller.sessionId,
          endpoint: 'https://push.example.test/ada',
          p256dh: 'p',
          auth: 'a',
          server_key: 'k',
        })
        .execute();
      // A link for ada's address, and — the control — one for somebody else's.
      const adaEmail = await emailOf(db, ada.userId);
      const links = linksOver(db);
      for (const email of [adaEmail, 'someone@example.test']) {
        await links.issue(email, { locale: 'en' });
      }
      expect(await linkRowsFor(db, [adaEmail, 'someone@example.test'])).toHaveLength(2);
      // And the count of what her address was sent this hour, kept by its digest.
      const after = afterAnswer(aRecordingLogger().log, 'sign-in');
      await requestSignInLink(
        {
          database: db,
          clock,
          log: aRecordingLogger().log,
          appUrl: 'https://purlay.test',
          links,
          later: after.run,
        },
        { email: adaEmail, locale: 'en' },
        '203.0.113.7',
      );
      await after.settled();
      const counter = await addressCounterKey(adaEmail);
      const counters = async (): Promise<number> =>
        (await db.selectFrom('rate_limits').select('key').where('key', '=', counter).execute())
          .length;
      expect(await counters()).toBe(1);
      // And how many invitation letters she sent today, kept under her id; bob's is the control.
      for (const person of [ada, member(room, 'bob')]) {
        await sql`insert into rate_limits (key, count, last_request)
          values (${inviterMailKey(person.userId)}, 3, ${String(clock.now().getTime() + DAY_MS)})`.execute(
          db,
        );
      }

      // And the wrong passwords counted for her address, from a client; bob's is the control.
      const bobEmail = await emailOf(db, member(room, 'bob').userId);
      await countAttempt(db, clock, adaEmail, '203.0.113.7');
      await countAttempt(db, clock, bobEmail, '203.0.113.7');
      const attemptsOf = async (email: string): Promise<number> =>
        (
          await db
            .selectFrom('rate_limits')
            .select('key')
            .where('key', 'like', `${await addressAttemptsPrefix(email)}%`)
            .execute()
        ).length;
      expect(await attemptsOf(adaEmail)).toBe(1);

      // The control for what is deleted: ada was told of bob's reply.
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('user_id', '=', ada.userId)
          .execute(),
      ).toHaveLength(1);
      const erased = await erase(db, caller, ada.username);
      expect(erased.userId).toBe(ada.userId);
      expect(erased.workspaces.map((workspace) => workspace.id)).toEqual([room.workspaceId]);

      const row = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', ada.userId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        email: `erased-${ada.userId}@erased.invalid`,
        github_id: null,
        github_login: null,
        github_connected_at: null,
        avatar_url: null,
        title: null,
        time_zone: null,
        status_text: null,
        last_seen_at: null,
        deleted_at: NOW,
      });
      expect(isErased({ username: row.username })).toBe(true);
      expect(row.display_name).toBe(row.username);
      expect(JSON.stringify(row)).not.toContain(ada.username);

      // Every session ends, the one that asked included, and its address and browser go with its row
      // (D-139 §5, D-179 §3): it resolves through the seam as nobody, and the trail keeps no pointer to it.
      expect(
        await db.selectFrom('sessions').select('id').where('user_id', '=', ada.userId).execute(),
      ).toEqual([]);
      expect(
        await sessionFromHeaders(aTestAuth(db), new Headers({ cookie: caller.cookie })),
      ).toBeUndefined();
      for (const table of [
        'push_subscriptions',
        'saved_messages',
        'thread_follows',
        'notifications',
      ] as const) {
        expect(
          await db.selectFrom(table).select('user_id').where('user_id', '=', ada.userId).execute(),
        ).toEqual([]);
      }
      expect(await linkRowsFor(db, [adaEmail, 'someone@example.test'])).toEqual([
        'someone@example.test',
      ]);
      expect(await counters()).toBe(0);
      expect(await attemptsOf(adaEmail)).toBe(0);
      expect(await attemptsOf(bobEmail)).toBe(1);
      expect(
        (
          await db
            .selectFrom('rate_limits')
            .select('key')
            .where('key', 'like', 'purlay:invite-mail:inviter:%')
            .execute()
        ).map((counter) => counter.key),
      ).toEqual([inviterMailKey(member(room, 'bob').userId)]);

      // The control: the team's history is whole, under the anonymised row.
      expect(
        await db
          .selectFrom('messages')
          .select(['content', 'sender_id', 'deleted_at'])
          .where('id', '=', sent.message.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        content: `hello @${member(room, 'bob').username}`,
        sender_id: ada.userId,
        deleted_at: null,
      });
      expect(
        await db
          .selectFrom('reactions')
          .select('emoji')
          .where('user_id', '=', ada.userId)
          .execute(),
      ).toEqual([{ emoji: '👍' }]);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('user_id')
          .where('user_id', '=', ada.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('audit_log')
          .select(['action', 'actor_user_id', 'target_id'])
          .where('workspace_id', '=', room.workspaceId)
          .where('action', '=', 'account.erased')
          .execute(),
      ).toEqual([{ action: 'account.erased', actor_user_id: ada.userId, target_id: ada.userId }]);
    });
  });

  /** ada, a GitHub account, erased: her old address and her GitHub id are free again. */
  const erasedAda = async (
    db: Transaction,
  ): Promise<{ id: string; email: string; name: string }> => {
    // bob owns it (the first is the owner): ada is free to go.
    const room = await aRoom(db, ['bob', 'ada']);
    const ada = member(room, 'ada');
    await db.updateTable('users').set({ github_id: '777' }).where('id', '=', ada.userId).execute();
    const email = await emailOf(db, ada.userId);
    await erase(db, await signedIn(db, room, 'ada'), ada.username);
    return { id: ada.userId, email, name: ada.username };
  };

  test('the passports made for the erased address go with it, and no other address’s or cookie’s does', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      const bob = member(room, 'bob');
      const adaEmail = await emailOf(db, ada.userId);
      const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
      const { token, invitation } = await createInvitation(db, clock, context);
      // Mixed case and padding: the digest is of the address as it is compared (D-40).
      await issuePassport(db, clock, { token, email: `  ${adaEmail.toUpperCase()} ` });
      await issuePassport(db, clock, { token, email: `x${adaEmail}` });
      await issuePassport(db, clock, { token });
      const digests = async (): Promise<(string | null)[]> =>
        (
          await db
            .selectFrom('invitation_passports')
            .select('address_digest')
            .where('invitation_id', '=', invitation.id)
            .execute()
        ).map((row) => row.address_digest);
      expect(await digests()).toHaveLength(3);
      await erase(db, await signedIn(db, room, 'ada'), ada.username);
      const left = await digests();
      expect(left).toHaveLength(2);
      expect(left).not.toContain(await tokenDigest(adaEmail));
      expect(left).toContain(await tokenDigest(`x${adaEmail}`));
    });
  });

  test('an erased server administrator keeps neither the flag nor the verified mark on the tombstone', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      await db
        .updateTable('users')
        .set({ is_server_admin: true, email_verified: true })
        .where('id', '=', ada.userId)
        .execute();
      await erase(db, await signedIn(db, room, 'ada'), ada.username);
      const tombstone = await db
        .selectFrom('users')
        .select(['is_server_admin', 'email_verified'])
        .where('id', '=', ada.userId)
        .executeTakeFirstOrThrow();
      expect(tombstone).toEqual({ is_server_admin: false, email_verified: false });
    });
  });

  test('the library tokens that name their address go with the account, and no near miss does', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada', 'cem', 'dan']);
      const soon = new Date(NOW.getTime() + 5 * MINUTE);
      // Two people whose addresses a pattern would mistake for others': `%` and `_` are a pattern's
      // wildcards, and `a@b.co` is the end of `aa@b.co`.
      const cases = [
        { name: 'ada', email: 'a@b.co', nearMisses: ['aa@b.co', 'a@b.coo', 'xa@b.co'] },
        { name: 'cem', email: 'c_x@b.co', nearMisses: ['cax@b.co', 'c_xx@b.co', 'cc_x@b.co'] },
        // An address GitHub vouched for may hold a `%`, which no link is ever asked for: its rows
        // are written as the library writes them.
        { name: 'dan', email: 'd%@b.co', nearMisses: ['dxyz@b.co', 'd%x@b.co'], written: true },
      ] as const;
      const links = linksOver(db);
      for (const { name, email, nearMisses, ...how } of cases) {
        await db
          .updateTable('users')
          .set({ email })
          .where('id', '=', member(room, name).userId)
          .execute();
        for (const address of [email, ...nearMisses]) {
          // What Better Auth writes, made by it: the identifier a prefix and the token's digest, never
          // the address, which is in a link's value as JSON (D-179).
          if (!('written' in how)) await links.issue(address, { locale: 'en' });
          else {
            await db
              .insertInto('verifications')
              .values({
                identifier: `magic-link:${crypto.randomUUID()}`,
                value: JSON.stringify({ type: 'magic-link', email: address }),
                expires_at: soon,
              })
              .execute();
          }
        }
      }
      // A password reset's value is a user's id: the library has no reset mail configured here, so
      // those rows are written as it writes them. And a value that is not JSON at all, which the
      // match must step over rather than fail on.
      await db
        .insertInto('verifications')
        .values([
          { identifier: 'reset-password:ada', value: member(room, 'ada').userId, expires_at: soon },
          { identifier: 'reset-password:bob', value: member(room, 'bob').userId, expires_at: soon },
          { identifier: 'other:x', value: '{not json', expires_at: soon },
        ])
        .execute();
      for (const { name } of cases) {
        await erase(db, await signedIn(db, room, name), member(room, name).username);
      }
      const everyAddress = cases.flatMap(({ email, nearMisses }) => [email, ...nearMisses]);
      expect(await linkRowsFor(db, everyAddress)).toEqual(
        cases.flatMap(({ nearMisses }) => nearMisses).sort(),
      );
      const left = await db
        .selectFrom('verifications')
        .select('identifier')
        .where('identifier', 'in', ['reset-password:ada', 'reset-password:bob', 'other:x'])
        .orderBy('identifier')
        .execute();
      expect(left.map((row) => row.identifier)).toEqual(['other:x', 'reset-password:bob']);
    });
  });

  test('the accounts a sign-in library kept for them go with it: a provider id and a password hash', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      await db
        .insertInto('accounts')
        .values([
          { user_id: ada.userId, provider_id: 'github', account_id: '4242' },
          { user_id: ada.userId, provider_id: 'credential', account_id: ada.userId, password: 'h' },
        ])
        .execute();
      await erase(db, await signedIn(db, room, 'ada'), ada.username);
      const left = await db
        .selectFrom('accounts')
        .select('id')
        .where('user_id', '=', ada.userId)
        .execute();
      expect(left).toEqual([]);
    });
  });

  test('a link that would verify their address as the setup’s administrator goes with the account', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      await db
        .insertInto('admin_email_verification')
        .values({
          user_id: ada.userId,
          email: await emailOf(db, ada.userId),
          token_digest: 'a'.repeat(64),
          issued_at: NOW,
        })
        .execute();
      await erase(db, await signedIn(db, room, 'ada'), ada.username);
      const left = await db
        .selectFrom('admin_email_verification')
        .select('user_id')
        .where('user_id', '=', ada.userId)
        .execute();
      expect(left).toEqual([]);
    });
  });

  test('a later GitHub sign-in is a new account, never the erased one', async () => {
    await withRollback(async (db) => {
      const ada = await erasedAda(db);
      // As the library makes the account of a GitHub sign-in: a new row, under the address the erased
      // account gave up, then what the sign-in writes.
      const byGitHub = await db
        .insertInto('users')
        .values({
          github_id: '777',
          email: ada.email,
          username: 'pending-777',
          display_name: 'Ada',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await recordGitHubSignIn(db, clock, {
        userId: byGitHub.id,
        profile: { id: 777, login: ada.name, name: 'Ada', avatarUrl: null },
        made: true,
      });
      expect(byGitHub.id).not.toBe(ada.id);
    });
  });

  test('a later sign-in by the old address is a new account, never the erased one', async () => {
    await withRollback(async (db) => {
      const ada = await erasedAda(db);
      const links = linksOver(db);
      const after = afterAnswer(aRecordingLogger().log, 'sign-in');
      const dependencies = {
        database: db,
        clock,
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        links,
        later: after.run,
      };
      await requestSignInLink(dependencies, { email: ada.email, locale: 'en' }, '203.0.113.7');
      await after.settled();
      const token = /#([0-9a-f]{64})/.exec(links.outbox.posted[0]?.text ?? '')?.[1] ?? '';
      expect(token).toHaveLength(64);
      await consumeSignInLink(dependencies, token, new Headers());
      const byMail = await db
        .selectFrom('users')
        .select('id')
        .where('email', '=', ada.email)
        .executeTakeFirstOrThrow();
      expect(byMail.id).not.toBe(ada.id);
    });
  });

  test('a login that begins as an erased name does is given another, so it stays a person', async () => {
    await withRollback(async (db) => {
      const made = await db
        .insertInto('users')
        .values({
          github_id: '99123',
          email: 'abc@example.test',
          username: 'pending-99123',
          display_name: 'pending',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await recordGitHubSignIn(db, clock, {
        userId: made.id,
        profile: { id: 99_123, login: 'deleted-user-abc', name: null, avatarUrl: null },
        made: true,
      });
      const { username } = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(username).toBe('user-deleted-user-abc');
      expect(isErased({ username })).toBe(false);
    });
  });

  test('asked for on purpose: the username typed, and a sign-in from the last minutes', async () => {
    await withRollback(async (db) => {
      // bob owns it (the first is the owner): ada is free to go.
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      const fresh = await signedIn(db, room, 'ada');
      expect(await attempt(db, () => erase(db, fresh, 'not-ada'))).toBe('VALIDATION_FAILED');
      const atTheEdge = await signedIn(db, room, 'ada', ERASURE_SIGN_IN_MINUTES * MINUTE);
      const past = await signedIn(db, room, 'ada', ERASURE_SIGN_IN_MINUTES * MINUTE + 1);
      expect(await attempt(db, () => erase(db, past, ada.username))).toBe(
        'REAUTHENTICATION_REQUIRED',
      );
      // Nothing was erased by the refusals.
      expect(
        (
          await db
            .selectFrom('users')
            .select('deleted_at')
            .where('id', '=', ada.userId)
            .executeTakeFirstOrThrow()
        ).deleted_at,
      ).toBeNull();
      expect(await attempt(db, () => erase(db, atTheEdge, ada.username))).toBe('taken');
    });
  });

  test('the last live owner of a workspace with somebody else in it hands it over first', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await owner(db, room, 'ada');
      const ada = member(room, 'ada');
      const refused = await erase(db, await signedIn(db, room, 'ada'), ada.username).then(
        () => null,
        (error: unknown) => error,
      );
      // It names the workspace to hand over (D-139 §6).
      expect(refused).toMatchObject({
        body: { code: 'LAST_OWNER', details: { workspaceIds: [room.workspaceId] } },
      });
    });
  });

  test('alone in a workspace, or beside only the erased, the last owner may go', async () => {
    await withRollback(async (db) => {
      const alone = await aRoom(db, ['ada']);
      await owner(db, alone, 'ada');
      const ada = member(alone, 'ada');
      const context = await requireWorkspaceMembership(db, ada.userId, alone.workspaceId);
      const link = await createInvitation(db, clock, context);
      expect(
        await attempt(
          db,
          async () => await erase(db, await signedIn(db, alone, 'ada'), ada.username),
        ),
      ).toBe('taken');
      // Nobody live owns it now: its open link no longer opens, or a newcomer would join a workspace
      // nobody can ever own again (I-2).
      const newcomer = await aUserRow(db, 'newcomer');
      expect(
        await attempt(db, () => acceptInvitation(db, clock, newcomer.userId, link.token)),
      ).toBe('INVITATION_NOT_FOUND');

      const beside = await aRoom(db, ['cy', 'dee']);
      await owner(db, beside, 'cy');
      await erase(db, await signedIn(db, beside, 'dee'), member(beside, 'dee').username);
      expect(
        await attempt(
          db,
          async () =>
            await erase(db, await signedIn(db, beside, 'cy'), member(beside, 'cy').username),
        ),
      ).toBe('taken');
    });
  });

  test('an erased owner counts for nothing: the one live owner left cannot step down', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob', 'cy']);
      await owner(db, room, 'ada');
      await owner(db, room, 'bob');
      // bob may go: ada is a live owner beside him.
      await erase(db, await signedIn(db, room, 'bob'), member(room, 'bob').username);
      const ada = member(room, 'ada');
      const context = await requireWorkspaceMembership(db, ada.userId, room.workspaceId);
      expect(await attempt(db, () => changeRole(db, clock, context, ada.userId, 'member'))).toBe(
        'LAST_OWNER',
      );
      // Nor may ada go now: cy is still here, and nobody live would own it.
      expect(
        await attempt(
          db,
          async () => await erase(db, await signedIn(db, room, 'ada'), ada.username),
        ),
      ).toBe('LAST_OWNER');
    });
  });
});
