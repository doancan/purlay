/** The real administrator guest endpoint preserves scope privacy and ordinary authorization failures. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  WorkspaceMember,
  UpdatedGuestAccess,
  WorkspaceGuestPage,
  type ServerFrame,
} from '@purlay/types';
import { inProcessBackplane, type Backplane, type InspectableEventBus } from '../../realtime/bus';
import { userTopic } from '../../platform/events';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { createChannel } from '../../features/chat/channels/channels';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createGuestInvitation } from '../../modules/workspaces/guest-invitations';
import { acceptInvitation } from '../../modules/workspaces/invitations';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: administrator guest HTTP reads', () => {
  test('conversion publishes a target-only resync hint after commit, and a confirmed retry publishes nothing', async () => {
    await withRollback(async (db) => {
      const clock = fixedClock(new Date());
      const room = await aRoom(db, ['owner']);
      const actor = await aSignedInUser(db, clock, 'convert-http-owner');
      const guest = await aSignedInUser(db, clock, 'convert-http-guest');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: room.workspaceId, user_id: actor.userId, role: 'owner' })
        .execute();
      const account = await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', guest.userId)
        .returning('email')
        .executeTakeFirstOrThrow();
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const invite = await createGuestInvitation(
        db,
        clock,
        owner,
        { email: account.email, channelIds: [room.channelId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      await acceptInvitation(
        db,
        clock,
        guest.userId,
        invite.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const told: [string, ServerFrame][] = [];
      const shared = inProcessBackplane();
      const backplane: Backplane = {
        node: (deliver, log, onGap): InspectableEventBus => {
          const bus = shared.node(deliver, log, onGap);
          return {
            ...bus,
            publish: async (topic, frame): Promise<void> => {
              told.push([topic, frame]);
              await bus.publish(topic, frame);
            },
          };
        },
      };
      const app = createApp(testDependencies({ database: db, clock, backplane }));
      const request = (body: unknown): Request =>
        new Request(
          `https://purlay.test/api/workspaces/${room.workspaceId}/guests/${guest.userId}/conversion`,
          {
            method: 'POST',
            headers: { cookie: actor.cookie, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      expect((await app.handle(request({ confirmFullAccess: false }))).status).toBe(400);
      expect(told).toEqual([]);
      const response = await app.handle(request({ confirmFullAccess: true }));
      expect(response.status).toBe(200);
      expect(Value.Check(WorkspaceMember, await response.json())).toBe(true);
      const hints = told.filter(
        ([, frame]) => frame.event === 'WORKSPACE_UPDATED' && frame.data.accessChanged === true,
      );
      expect(hints).toEqual([
        [
          userTopic(guest.userId),
          {
            event: 'WORKSPACE_UPDATED',
            data: { workspaceId: room.workspaceId, accessChanged: true },
            ts: clock.now().getTime(),
          },
        ],
      ]);
      expect(told.some(([, frame]) => frame.event === 'ACCESS_REVOKED')).toBe(false);
      told.length = 0;
      expect((await app.handle(request({ confirmFullAccess: true }))).status).toBe(200);
      expect(told).toEqual([]);
    });
  });

  test('answers only to a current administrator and never includes a hidden channel identity', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const clock = fixedClock(new Date());
      const admin = await aSignedInUser(db, clock, 'guest-list-admin');
      const member = await aSignedInUser(db, clock, 'guest-list-member');
      const stranger = await aSignedInUser(db, clock, 'guest-list-stranger');
      const guest = await aSignedInUser(db, clock, 'guest-list-target');
      await db
        .insertInto('workspace_members')
        .values([
          { workspace_id: room.workspaceId, user_id: admin.userId, role: 'admin' },
          { workspace_id: room.workspaceId, user_id: member.userId, role: 'member' },
        ])
        .execute();
      const recipient = await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', guest.userId)
        .returning('email')
        .executeTakeFirstOrThrow();
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const privateChannel = await createChannel(db, clock, owner, {
        name: 'not-the-admins-channel',
        type: 'private',
      });
      const made = await createGuestInvitation(
        db,
        clock,
        owner,
        {
          email: recipient.email,
          channelIds: [room.channelId, privateChannel.id],
          accessExpiresAt: null,
        },
        chatWorkspaceChannels,
      );
      await acceptInvitation(
        db,
        clock,
        guest.userId,
        made.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const told: [string, ServerFrame][] = [];
      const shared = inProcessBackplane();
      const backplane: Backplane = {
        node: (deliver, log, onGap): InspectableEventBus => {
          const bus = shared.node(deliver, log, onGap);
          return {
            ...bus,
            publish: async (topic, frame): Promise<void> => {
              told.push([topic, frame]);
              await bus.publish(topic, frame);
            },
          };
        },
      };
      const app = createApp(testDependencies({ database: db, clock, backplane }));
      const read = async (cookie: string, query = ''): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/guests${query}`, {
            headers: { cookie },
          }),
        );
      const response = await read(admin.cookie);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(Value.Check(WorkspaceGuestPage, body)).toBe(true);
      expect(body).toMatchObject({
        data: [{ user: { id: guest.userId }, channelIds: [room.channelId], hiddenChannelCount: 1 }],
        nextCursor: null,
      });
      expect(JSON.stringify(body)).not.toContain(privateChannel.id);
      expect(JSON.stringify(body)).not.toContain(recipient.email);
      expect((await read(member.cookie)).status).toBe(403);
      expect((await read(guest.cookie)).status).toBe(403);
      expect((await read(stranger.cookie)).status).toBe(404);
      expect((await read('')).status).toBe(401);
      expect((await read(admin.cookie, '?limit=0')).status).toBe(400);
      expect(
        await (await read(admin.cookie, `?q=${encodeURIComponent(recipient.email)}`)).json(),
      ).toMatchObject({ data: [], nextCursor: null });
      const patch = async (
        cookie: string,
        body: unknown,
        target = guest.userId,
      ): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/guests/${target}`, {
            method: 'PATCH',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      expect((await patch(member.cookie, { channelIds: [] })).status).toBe(403);
      expect((await patch(guest.cookie, { channelIds: [] })).status).toBe(403);
      expect((await patch(stranger.cookie, { channelIds: [] })).status).toBe(404);
      expect((await patch('', { channelIds: [] })).status).toBe(401);
      expect((await patch(admin.cookie, { role: 'owner' })).status).toBe(400);
      expect((await patch(admin.cookie, { channelIds: [privateChannel.id] })).status).toBe(404);
      expect((await patch(admin.cookie, { channelIds: [] }, member.userId)).status).toBe(404);
      expect(told).toEqual([]);
      await aRoom(db, ['owner']);
      const edited = await patch(admin.cookie, { channelIds: [] });
      expect(edited.status).toBe(200);
      const accepted: unknown = await edited.json();
      expect(Value.Check(UpdatedGuestAccess, accepted)).toBe(true);
      expect(accepted).toMatchObject({ channelIds: [], hiddenChannelCount: 1 });
      expect(JSON.stringify(accepted)).not.toContain(privateChannel.id);
      expect(told.slice(0, 2)).toMatchObject([
        [
          userTopic(guest.userId),
          { event: 'ACCESS_REVOKED', data: { channelIds: [room.channelId] } },
        ],
        [userTopic(guest.userId), { event: 'CHANNELS_UPDATED' }],
      ]);
      expect(
        told
          .slice(2)
          .map(([topic, frame]) => [topic, frame.event])
          .sort(),
      ).toEqual(
        [
          [userTopic(owner.userId), 'WORKSPACE_UPDATED'],
          [userTopic(admin.userId), 'WORKSPACE_UPDATED'],
          [userTopic(guest.userId), 'WORKSPACE_UPDATED'],
        ].sort(),
      );
      told.length = 0;
      expect((await patch(admin.cookie, { channelIds: [] })).status).toBe(200);
      expect(told).toEqual([]);
      const removed = await app.handle(
        new Request(
          `https://purlay.test/api/workspaces/${room.workspaceId}/members/${guest.userId}`,
          {
            method: 'DELETE',
            headers: { cookie: admin.cookie },
          },
        ),
      );
      expect(removed.status).toBe(204);
      expect(told[0]).toMatchObject([
        userTopic(guest.userId),
        { event: 'ACCESS_REVOKED', data: { channelIds: [privateChannel.id] } },
      ]);
      expect(
        told
          .slice(1)
          .map(([topic, frame]) => [topic, frame.event])
          .sort(),
      ).toEqual(
        [
          [userTopic(owner.userId), 'WORKSPACE_UPDATED'],
          [userTopic(admin.userId), 'WORKSPACE_UPDATED'],
          [userTopic(guest.userId), 'WORKSPACE_UPDATED'],
        ].sort(),
      );
    });
  });

  test('a guest leaving voluntarily refreshes their other sessions and current administrators after revocation', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const clock = fixedClock(new Date());
      const target = await aSignedInUser(db, clock, 'voluntary-guest');
      const recipient = await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', target.userId)
        .returning('email')
        .executeTakeFirstOrThrow();
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const invite = await createGuestInvitation(
        db,
        clock,
        owner,
        { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      await acceptInvitation(
        db,
        clock,
        target.userId,
        invite.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const told: [string, ServerFrame][] = [];
      const shared = inProcessBackplane();
      const backplane: Backplane = {
        node: (deliver, log, onGap): InspectableEventBus => {
          const bus = shared.node(deliver, log, onGap);
          return {
            ...bus,
            publish: async (topic, frame): Promise<void> => {
              told.push([topic, frame]);
              await bus.publish(topic, frame);
            },
          };
        },
      };
      const app = createApp(testDependencies({ database: db, clock, backplane }));
      const response = await app.handle(
        new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/membership`, {
          method: 'DELETE',
          headers: { cookie: target.cookie },
        }),
      );
      expect(response.status).toBe(204);
      expect(told[0]).toMatchObject([
        userTopic(target.userId),
        { event: 'ACCESS_REVOKED', data: { channelIds: [room.channelId] } },
      ]);
      expect(
        told
          .slice(1)
          .map(([topic, frame]) => [topic, frame.event])
          .sort(),
      ).toEqual(
        [
          [userTopic(owner.userId), 'WORKSPACE_UPDATED'],
          [userTopic(target.userId), 'WORKSPACE_UPDATED'],
        ].sort(),
      );
    });
  });
});
