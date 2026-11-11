/** Current authority wins over old contexts, message retry IDs and invitation recipients.
 * @needs-modules chat
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Transaction,
  type Selectable,
  type WorkspaceInvitations,
  type WorkspaceInvitationMailAttempts,
  type RateLimits,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { aRoom, type Room } from '../../testing/rooms';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { attempt } from '../../testing/attempt';
import { linkFile } from '../../testing/sent-files';
import { aRecordingOutbox, testConfig, testDependencies } from '../../testing/doubles';
import { fixedClock, type Clock } from '../../platform/clock';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { requireChannelById, type ChannelContext } from '../../features/chat/channels/guard';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { channelFiles } from '../../features/chat/channels/files';
import { missedIn } from '../../features/chat/messages/messages';
import { searchIn } from '../../features/chat/search/search';
import { removeMember } from '../../modules/workspaces/members';
import { createGuestInvitation } from '../../modules/workspaces/guest-invitations';
import { acceptInvitation } from '../../modules/workspaces/invitations';
import {
  makeAndMailGuestInvitation,
  makeAndMailInvitation,
  resendInvitationRecipient,
} from '../../modules/workspaces/invitation-mail';
import { finishInvitationAttempt } from '../../modules/workspaces/invitation-delivery';
import { createApp } from './app';

afterAll(closeIntegrationDatabase);

interface Readmission {
  readonly room: Room;
  readonly target: SignedInUser;
  readonly owner: WorkspaceContext;
  readonly clock: Clock;
  readonly oldId: string;
  readonly workspace: WorkspaceContext;
  readonly channel: ChannelContext;
}

const readmission = async (db: Transaction, age: number): Promise<Readmission> => {
  const at = new Date();
  const clock = fixedClock(at);
  const room = await aRoom(db, ['owner']);
  const target = await aSignedInUser(db, clock, 'readmitted-guest');
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: room.workspaceId,
      user_id: target.userId,
      role: 'member',
    })
    .execute();
  await db
    .insertInto('channel_members')
    .values({
      channel_id: room.channelId,
      user_id: target.userId,
      joined_at: new Date(at.getTime() - age - 1_000),
    })
    .execute();
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', target.userId)
    .execute();
  const owner = await requireWorkspaceMembership(
    db,
    room.members['owner']?.userId ?? '',
    room.workspaceId,
  );
  const workspace = await requireWorkspaceMembership(db, target.userId, room.workspaceId);
  const channel = await requireChannelById(db, target.userId, room.channelId);
  const oldAt = new Date(at.getTime() - age);
  const oldId = messageId(oldAt);
  await db
    .insertInto('messages')
    .values({
      id: oldId,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: target.userId,
      content: 'supplier predecessor history',
      created_at: oldAt,
    })
    .execute();
  await removeMember(
    db,
    fixedClock(new Date(at.getTime() - 1)),
    owner,
    target.userId,
    chatWorkspaceChannels,
  );
  await db
    .updateTable('messages')
    .set({
      is_question: true,
      knowledge_version: 1,
      decision_note: 'staff-only decision after removal',
      decision_updated_by: owner.userId,
    })
    .where('id', '=', oldId)
    .execute();
  const invitation = await createGuestInvitation(
    db,
    clock,
    owner,
    {
      email: target.email,
      channelIds: [room.channelId],
      accessExpiresAt: null,
    },
    chatWorkspaceChannels,
  );
  await acceptInvitation(
    db,
    clock,
    target.userId,
    invitation.token,
    undefined,
    chatWorkspaceChannels,
    true,
  );
  return { room, target, owner, clock, oldId, workspace, channel };
};

const attach = async (
  db: Transaction,
  fixture: Awaited<ReturnType<typeof readmission>>,
  id: string,
): Promise<string> => {
  const fileId = messageId(new Date());
  await db
    .insertInto('attachments')
    .values({
      id: fileId,
      workspace_id: fixture.room.workspaceId,
      uploader_id: fixture.owner.userId,
      storage_key: `w/${fixture.room.workspaceId}/${fileId}`,
      file_name: 'supplier-contract.pdf',
      mime_type: 'application/pdf',
      size_bytes: '1',
    })
    .execute();
  await linkFile(db, {
    id: fileId,
    workspaceId: fixture.room.workspaceId,
    messageId: id,
    channelId: fixture.room.channelId,
  });
  return fileId;
};

describe('integration: guest boundaries use current authority', () => {
  test('a captured full-member replay cannot return pre-admission content after guest re-admission', async () => {
    await withRollback(async (db) => {
      const f = await readmission(db, 120_000);
      const replay = await missedIn(db, [{ context: f.channel, after: messageId(new Date(0)) }], 1);
      expect(replay.get(f.room.channelId)).toEqual({ data: [], nextCursor: null });
    });
  });

  test('captured full-member list and replay readers apply the new guest floor before pagination', async () => {
    await withRollback(async (db) => {
      const f = await readmission(db, 120_000);
      await attach(db, f, f.oldId);
      const newAt = new Date(f.clock.now().getTime() + 1_000);
      const newId = messageId(newAt);
      await db
        .insertInto('messages')
        .values({
          id: newId,
          workspace_id: f.room.workspaceId,
          channel_id: f.room.channelId,
          sender_id: f.owner.userId,
          content: 'supplier current share',
          created_at: newAt,
        })
        .execute();
      const fileId = await attach(db, f, newId);
      const currentWorkspace = await requireWorkspaceMembership(
        db,
        f.target.userId,
        f.room.workspaceId,
      );
      const currentChannel = await requireChannelById(db, f.target.userId, f.room.channelId);
      for (const [workspace, channel] of [
        [currentWorkspace, currentChannel],
        [f.workspace, f.channel],
      ] as const) {
        const search = await searchIn(db, workspace, [f.room.channelId], {
          q: 'supplier',
          limit: 1,
        });
        expect(search.data.map((m) => m.id)).toEqual([newId]);
        expect(search.nextCursor).toBeNull();
        const files = await channelFiles(db, channel, { limit: 1 });
        expect(files.data.map((file) => file.attachment.id)).toEqual([fileId]);
        expect(files.nextCursor).toBeNull();
        const replay = (
          await missedIn(db, [{ context: channel, after: messageId(new Date(0)) }], 1)
        ).get(f.room.channelId);
        expect(replay?.data.map((m) => m.id)).toEqual([newId]);
        expect(replay?.nextCursor).toBeNull();
      }
      await removeMember(db, f.clock, f.owner, f.target.userId, chatWorkspaceChannels);
      expect((await searchIn(db, f.workspace, [f.room.channelId], { q: 'supplier' })).data).toEqual(
        [],
      );
      expect((await channelFiles(db, f.channel, {})).data).toEqual([]);
      expect(
        (await missedIn(db, [{ context: f.channel, after: messageId(new Date(0)) }], 1)).get(
          f.room.channelId,
        )?.data,
      ).toEqual([]);
    });
  });

  test.each([86_400_000, 1_000])(
    'retrying an own message from before readmission refuses at age %s',
    async (age) => {
      await withRollback(async (db) => {
        const f = await readmission(db, age);
        const app = createApp(testDependencies({ database: db, clock: f.clock }));
        const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
          await app.handle(
            new Request('https://purlay.test' + path, {
              method,
              headers: {
                cookie: f.target.cookie,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        expect((await call('GET', `/api/messages/${f.oldId}`)).status).toBe(404);
        const retried = await call('POST', `/api/channels/${f.room.channelId}/messages`, {
          id: f.oldId,
          content: 'retry',
        });
        expect(retried.status).toBe(404);
        expect(await retried.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
        const freshId = messageId(f.clock.now());
        for (let repeat = 0; repeat < 2; repeat++) {
          const sent = await call('POST', `/api/channels/${f.room.channelId}/messages`, {
            id: freshId,
            content: 'current supplier message',
          });
          expect(sent.status).toBe(201);
          expect(await sent.json()).toMatchObject({
            id: freshId,
            content: 'current supplier message',
          });
        }
        expect(
          await db
            .selectFrom('messages')
            .select('content')
            .where('id', '=', f.oldId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ content: 'supplier predecessor history' });
      });
    },
  );

  test('guest recipient resends require actual rollout readiness without changing ordinary resends', async () => {
    await withRollback(async (db) => {
      const clock = fixedClock(new Date());
      const room = await aRoom(db, ['owner']);
      const manager = await aSignedInUser(db, clock, 'guest-resend-owner');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: room.workspaceId, user_id: manager.userId, role: 'owner' })
        .execute();
      const owner = await requireWorkspaceMembership(db, manager.userId, room.workspaceId);
      const mail = { on: true, appUrl: 'https://purlay.test' };
      const guest = await makeAndMailGuestInvitation(
        db,
        clock,
        owner,
        { email: 'named@example.test', channelIds: [room.channelId], accessExpiresAt: null },
        mail,
        chatWorkspaceChannels,
        true,
      );
      const normal = await makeAndMailInvitation(
        db,
        clock,
        owner,
        { emails: ['normal@example.test'] },
        mail,
      );
      const recipients: string[] = [];
      for (const made of [guest, normal]) {
        const letter = made.letters[0];
        if (letter === undefined) throw new Error('Missing initial invitation letter');
        await finishInvitationAttempt(db, clock, letter.attemptId, { accepted: true });
        const recipient = await db
          .selectFrom('workspace_invitation_mail_attempts')
          .select('recipient_id')
          .where('id', '=', letter.attemptId)
          .executeTakeFirstOrThrow();
        recipients.push(recipient.recipient_id);
      }
      const posted = aRecordingOutbox();
      const resend = async (id: string, ready: boolean): Promise<Response> => {
        const app = createApp(
          testDependencies({
            database: db,
            clock,
            mail: posted,
            config: testConfig({ GUEST_ACCESS_READY: ready }),
          }),
        );
        const response = await app.handle(
          new Request(
            `https://purlay.test/api/workspaces/${room.workspaceId}/invitation-recipients/${id}/resend`,
            { method: 'POST', headers: { cookie: manager.cookie } },
          ),
        );
        await app.settled();
        return response;
      };
      const snapshot = async (): Promise<{
        invitations: Selectable<WorkspaceInvitations>[];
        attempts: Selectable<WorkspaceInvitationMailAttempts>[];
        quota: Selectable<RateLimits>[];
      }> => ({
        invitations: await db
          .selectFrom('workspace_invitations')
          .selectAll()
          .where('workspace_id', '=', room.workspaceId)
          .orderBy('id')
          .execute(),
        attempts: await db
          .selectFrom('workspace_invitation_mail_attempts')
          .selectAll()
          .where('workspace_id', '=', room.workspaceId)
          .orderBy('id')
          .execute(),
        quota: await db
          .selectFrom('rate_limits')
          .selectAll()
          .where('key', 'in', [
            `purlay:invite-mail:inviter:${manager.userId}`,
            `purlay:invite-mail:workspace:${room.workspaceId}`,
          ])
          .orderBy('key')
          .execute(),
      });
      const before = await snapshot();
      expect(
        await attempt(db, () =>
          resendInvitationRecipient(
            db,
            clock,
            owner,
            recipients[0] ?? '',
            mail,
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('PEERS_BEHIND');
      expect(await snapshot()).toEqual(before);
      const denied = await resend(recipients[0] ?? '', false);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: 'PEERS_BEHIND' } });
      expect(await snapshot()).toEqual(before);
      expect(posted.posted).toEqual([]);
      expect((await resend(recipients[1] ?? '', false)).status).toBe(204);
      expect((await resend(recipients[0] ?? '', true)).status).toBe(204);
      const after = await snapshot();
      expect(after.invitations).toHaveLength(before.invitations.length + 2);
      expect(after.attempts).toHaveLength(before.attempts.length + 2);
      expect(posted.posted.map((letter) => letter.to).sort()).toEqual([
        'named@example.test',
        'normal@example.test',
      ]);
    });
  });
});
