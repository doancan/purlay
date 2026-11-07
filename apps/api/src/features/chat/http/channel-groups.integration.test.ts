/** Personal navigation is private, without changing a channel's membership (#1198). */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { createApp } from '../../../ingress/http/app';
import { testDependencies } from '../../../testing/doubles';
import { aRoom } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { userTopic } from '../../../platform/events';
import {
  inProcessBackplane,
  type Backplane,
  type InspectableEventBus,
} from '../../../realtime/bus';
import type { ServerFrame } from '@purlay/types';
import { ChannelList } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-11-07T12:00:00.000Z'));

describe('integration: personal channel groups', () => {
  test('queries and bodies reject unknown or out-of-range input, and name collisions are recoverable', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const { token } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const path = `/api/workspaces/${room.workspaceId}/channel-groups`;
      const call = async (method: string, route: string, body?: unknown): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${route}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=1.5',
        'after=bad',
        'before=bad',
        'unknown=1',
        'limit=1&limit=2',
      ]) {
        expect((await call('GET', `${path}?${query}`)).status).toBe(400);
      }
      const id = crypto.randomUUID();
      for (const body of [
        { name: '' },
        { name: '   ' },
        { name: 'x'.repeat(65) },
        { name: 'line\nbreak' },
        { name: 'null\u0000byte' },
        { name: 'spoof\u202efile' },
        { name: 'Finance', userId: crypto.randomUUID() },
      ]) {
        expect((await call('PUT', `${path}/${id}`, body)).status).toBe(400);
      }
      for (const name of [
        'x',
        'x'.repeat(64),
        'Cafe\u0301',
        'مبيعات 🧾',
        "O'Brien'); DROP TABLE channel_groups; --",
        '<b>Finance</b>',
      ]) {
        const answer = await call('PUT', `${path}/${id}`, { name });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toMatchObject({ id, name: name.normalize('NFC') });
      }
      expect((await call('PUT', `${path}/${id}`, { name: 'Finance' })).status).toBe(200);
      const taken = await call('PUT', `${path}/${crypto.randomUUID()}`, { name: 'FINANCE' });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({ error: { code: 'CHANNEL_GROUP_NAME_TAKEN' } });
      expect((await call('PATCH', `${path}/${id}`, { collapsed: 'true' })).status).toBe(400);
      expect(
        (await call('PUT', `/api/channels/${room.channelId}/sidebar-group`, { groupId: 'bad' }))
          .status,
      ).toBe(400);
    });
  });

  test('workspace outsiders and anonymous callers cannot read headings, and a visible unjoined channel cannot be placed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['carol'] });
      const elsewhere = await aRoom(db, ['dave']);
      const outsider = await aSession(db, clock, elsewhere.members['dave']?.userId ?? '', 30);
      const viewer = await aSession(db, clock, room.outsiders['carol']?.userId ?? '', 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const path = `/api/workspaces/${room.workspaceId}/channel-groups`;
      expect((await app.handle(new Request(`https://purlay.test${path}`))).status).toBe(401);
      const call = async (
        method: string,
        route: string,
        token: string,
        body?: unknown,
      ): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${route}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      expect((await call('GET', path, outsider.token)).status).toBe(404);
      expect(
        (await call('PUT', `${path}/${crypto.randomUUID()}`, outsider.token, { name: 'Private' }))
          .status,
      ).toBe(404);
      expect((await call('GET', path, viewer.token)).status).toBe(200);
      expect(
        (
          await call('PUT', `/api/channels/${room.channelId}/sidebar-group`, viewer.token, {
            groupId: null,
          })
        ).status,
      ).toBe(404);
    });
  });

  test('only the owner is told, with no group names or ids, and identical retries are quiet', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const userId = room.members['alice']?.userId ?? '';
      const { token } = await aSession(db, clock, userId, 30);
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
      const id = crypto.randomUUID();
      const path = `/api/workspaces/${room.workspaceId}/channel-groups/${id}`;
      const call = async (method: string, route: string, body?: unknown): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${route}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      for (let index = 0; index < 2; index += 1)
        expect((await call('PUT', path, { name: 'Only mine' })).status).toBe(200);
      for (let index = 0; index < 2; index += 1)
        expect((await call('PATCH', path, { collapsed: true })).status).toBe(200);
      for (let index = 0; index < 2; index += 1)
        expect(
          (await call('PUT', `/api/channels/${room.channelId}/sidebar-group`, { groupId: id }))
            .status,
        ).toBe(200);
      for (let index = 0; index < 2; index += 1)
        expect((await call('DELETE', path)).status).toBe(204);
      expect(told).toHaveLength(4);
      for (const [topic, frame] of told) {
        expect(topic).toBe(userTopic(userId));
        expect(frame.event).toBe('CHANNELS_UPDATED');
        if (frame.event !== 'CHANNELS_UPDATED') throw new Error('unexpected publication');
        expect(frame.data).toEqual({ workspaceId: room.workspaceId });
      }
    });
  });
  test('a group is repeatable and private, and its deletion preserves the joined channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const app = createApp(testDependencies({ database: db, clock }));
      const token = async (who: string): Promise<string> =>
        (await aSession(db, clock, room.members[who]?.userId ?? '', 30)).token;
      const alice = await token('alice');
      const bob = await token('bob');
      const call = async (
        method: string,
        path: string,
        session: string,
        body?: unknown,
      ): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const groupId = crypto.randomUUID();
      const path = `/api/workspaces/${room.workspaceId}/channel-groups`;
      const saved = await call('PUT', `${path}/${groupId}`, alice, { name: 'Operasyon' });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        id: groupId,
        name: 'Operasyon',
        collapsed: false,
      });
      expect((await call('PUT', `${path}/${groupId}`, alice, { name: 'Operasyon' })).status).toBe(
        200,
      );
      expect(await (await call('GET', path, bob)).json()).toEqual({ data: [], nextCursor: null });
      const move = await call('PUT', `/api/channels/${room.channelId}/sidebar-group`, alice, {
        groupId,
      });
      expect(move.status).toBe(200);
      expect(await move.json()).toMatchObject({
        id: room.channelId,
        sidebarGroupId: groupId,
        starred: false,
      });
      expect((await call('DELETE', `${path}/${groupId}`, alice)).status).toBe(204);
      const channels: unknown = await (
        await call('GET', `/api/workspaces/${room.workspaceId}/channels`, alice)
      ).json();
      if (!Value.Check(ChannelList, channels)) throw new Error('Invalid channel response');
      const joined = channels.find((channel) => channel.id === room.channelId);
      if (joined === undefined) throw new Error('The joined channel disappeared');
      expect(joined.sidebarGroupId).toBeNull();
      expect(joined.state).not.toBeNull();
    });
  });
});
