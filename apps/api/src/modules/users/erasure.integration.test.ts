/**
 * Erasing an account against the real database (D-27 §2, D-139 §5–§6, I-11): every column that said who
 * they were, cleared — beside the control, what the team holds, still there under the anonymised row; a
 * later sign-in, by GitHub or by email, a new account; asked for with the username and a recent sign-in;
 * and a workspace never left without a live owner, nor one left so by an erased owner who still counts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { ERASURE_SIGN_IN_MINUTES, isErased, messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { aRecordingLogger } from '../../testing/doubles';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { issueSession } from '../auth/sessions';
import { resolveIdentity } from '../auth/identity';
import { consumeSignInLink, requestSignInLink } from '../auth/email-sign-in';
import { sendMessage } from '../messages/messages';
import { changeRole } from '../workspaces/members';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { eraseAccount } from './erasure';
import { acceptInvitation, createInvitation } from '../workspaces/invitations';
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
): Promise<{ userId: string; sessionId: string }> => {
  const { sessionId } = await issueSession(
    db,
    fixedClock(new Date(NOW.getTime() - ago)),
    member(room, name).userId,
    30,
    { ipAddress: '203.0.113.7', userAgent: 'Firefox' },
  );
  return { userId: member(room, name).userId, sessionId };
};

const emailOf = async (db: Transaction, userId: string): Promise<string> =>
  (await db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow())
    .email;

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
      for (const email of [adaEmail, 'someone@example.test']) {
        await requestSignInLink(
          db,
          { clock, appUrl: 'https://purlay.test', log: aRecordingLogger().log },
          { email, locale: 'en' },
        );
      }

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

      const session = await db
        .selectFrom('sessions')
        .select(['revoked_at', 'ip_address', 'user_agent'])
        .where('id', '=', caller.sessionId)
        .executeTakeFirstOrThrow();
      expect(session).toEqual({ revoked_at: NOW, ip_address: null, user_agent: null });
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
      expect(
        (
          await db
            .selectFrom('email_sign_ins')
            .select('email')
            .where('email', 'in', [adaEmail, 'someone@example.test'])
            .execute()
        ).map((r) => r.email),
      ).toEqual(['someone@example.test']);

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

  test('a later GitHub sign-in is a new account, never the erased one', async () => {
    await withRollback(async (db) => {
      const ada = await erasedAda(db);
      const byGitHub = await resolveIdentity(
        db,
        clock,
        { id: 777, login: ada.name, name: 'Ada', avatarUrl: null },
        [{ email: ada.email, primary: true, verified: true }],
      );
      expect(byGitHub.userId).not.toBe(ada.id);
    });
  });

  test('a later sign-in by the old address is a new account, never the erased one', async () => {
    await withRollback(async (db) => {
      const ada = await erasedAda(db);
      const sent = await requestSignInLink(
        db,
        { clock, appUrl: 'https://purlay.test', log: aRecordingLogger().log },
        { email: ada.email, locale: 'en' },
      );
      const token = /#([0-9a-f]{64})/.exec(sent?.text ?? '')?.[1] ?? '';
      expect(token).toHaveLength(64);
      const byMail = await consumeSignInLink(db, clock, token);
      expect(byMail.created).toBe(true);
      expect(byMail.userId).not.toBe(ada.id);
    });
  });

  test('a login that begins as an erased name does is given another, so it stays a person', async () => {
    await withRollback(async (db) => {
      const made = await resolveIdentity(
        db,
        clock,
        { id: 99_123, login: 'deleted-user-abc', name: null, avatarUrl: null },
        [{ email: 'abc@example.test', primary: true, verified: true }],
      );
      const { username } = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', made.userId)
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
