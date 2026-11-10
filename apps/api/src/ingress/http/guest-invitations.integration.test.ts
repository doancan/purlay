/** Guest invitation admission through the real HTTP application and chat readers. */
import { afterAll, describe, expect, test } from 'bun:test';
import { withRollback, closeIntegrationDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { createChannel } from '../../features/chat/channels/channels';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createGuestInvitation } from '../../modules/workspaces/guest-invitations';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: guest invitation HTTP admission', () => {
  test('the real HTTP acceptance path exposes only the selected post-admission history', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner'], { outsiders: ['other-employee'] });
      const clock = fixedClock(new Date());
      const recipient = await aSignedInUser(db, clock, 'http-guest');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', recipient.userId)
        .execute();
      const email = (
        await db
          .selectFrom('users')
          .select('email')
          .where('id', '=', recipient.userId)
          .executeTakeFirstOrThrow()
      ).email;
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const hidden = await createChannel(db, clock, owner, { name: 'not-shared-with-guests' });
      const oldId = messageId(new Date(clock.now().getTime() - 1_000));
      await db
        .insertInto('messages')
        .values({
          id: oldId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: owner.userId,
          content: 'Before admission',
          created_at: new Date(clock.now().getTime() - 1_000),
        })
        .execute();
      const invite = await createGuestInvitation(
        db,
        clock,
        owner,
        { email, channelIds: [room.channelId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      const app = createApp(testDependencies({ database: db, clock }));
      const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
        await app.handle(
          new Request('https://purlay.test' + path, {
            method,
            headers: {
              cookie: recipient.cookie,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      expect((await call('POST', '/api/invitations/preview', { token: invite.token })).status).toBe(
        200,
      );
      const accepted = await call('POST', '/api/invitations/accept', { token: invite.token });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        workspace: { id: room.workspaceId },
        access: { kind: 'guest' },
        modules: ['chat'],
      });
      const people = await call('GET', `/api/workspaces/${room.workspaceId}/members`);
      expect(people.status).toBe(200);
      const directory = (await people.json()) as { user: { id: string } }[];
      expect(directory.map((row) => row.user.id).sort()).toEqual(
        [owner.userId, recipient.userId].sort(),
      );
      const history = await call('GET', `/api/channels/${room.channelId}/messages`);
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({ data: [], nextCursor: null });
      expect((await call('GET', `/api/messages/${oldId}/context`)).status).toBe(404);
      expect((await call('GET', `/api/channels/${hidden.id}/messages`)).status).toBe(404);
    });
  });
});
