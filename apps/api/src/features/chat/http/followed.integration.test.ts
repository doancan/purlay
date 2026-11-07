/** The personal follow-list door validates complete cursors and never exposes another workspace. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { FollowedThreadsPage, messageId } from '@purlay/types';
import { createApp } from '../../../ingress/http/app';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { testDependencies } from '../../../testing/doubles';
import { aRoom } from '../../../testing/rooms';
import { aSession, aSignedInUser } from '../../../testing/signed-in';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(new Date('2026-11-07T12:00:00.000Z'));

describe('integration: followed conversations through HTTP', () => {
  test('returns the caller’s followed roots and refuses malformed, repeated and partial cursors', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['reader']);
      const reader = room.members['reader'];
      if (reader === undefined) throw new Error('Missing reader');
      const session = await aSession(db, clock, reader.userId);
      const app = createApp(testDependencies({ database: db, clock }));
      const path = `/api/workspaces/${room.workspaceId}/followed-threads`;
      const get = async (query = ''): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}${query}`, {
            headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
          }),
        );
      const rootId = messageId(clock.now());
      await db
        .insertInto('messages')
        .values({
          id: rootId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: reader.userId,
          content: 'Shift handover',
          created_at: clock.now(),
        })
        .execute();
      const response = await get('?limit=1&unreadOnly=false');
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!Value.Check(FollowedThreadsPage, body)) throw new Error('Invalid follow-list response');
      expect(body.data.map((row) => row.root.id)).toEqual([rootId]);
      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=1.5',
        '?limit=1&limit=2',
        '?unreadOnly=yes',
        '?unreadOnly=true&unreadOnly=false',
        `?beforeRootId=${rootId}`,
        '?beforeActivityAt=2026-11-07T12:00:00.000Z',
        `?beforeRootId=${rootId}&beforeActivityAt=2026-02-30T12:00:00.000Z`,
        `?userId=${reader.userId}`,
      ]) {
        const refused = await get(query);
        expect(refused.status).toBe(400);
      }
    });
  });

  test('requires a live session and current workspace membership before validating the query', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const outsider = await aSignedInUser(db, clock, 'outsider');
      const app = createApp(testDependencies({ database: db, clock }));
      const path = `https://purlay.test/api/workspaces/${room.workspaceId}/followed-threads?limit=0`;
      expect((await app.handle(new Request(path))).status).toBe(401);
      const stranger = await app.handle(
        new Request(path, { headers: { cookie: outsider.cookie } }),
      );
      expect(stranger.status).toBe(404);
    });
  });
});
