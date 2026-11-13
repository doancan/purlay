/** Personal delivery shares a statement without sharing recipients' visibility. @needs-modules chat */
import { afterAll, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import type { ServerFrame } from '@purlay/types';
import { aRoom } from '../testing/rooms';
import { aSession } from '../testing/signed-in';
import { aMovableClock } from '../testing/doubles';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { workspaceFrameProjector } from '../features/chat/channels/workspace-delivery';

afterAll(closeIntegrationDatabase);

test('integration: personal batches retain each private-channel membership and recheck policy activation', async () => {
  await withRollback(async (db) => {
    const room = await aRoom(db, ['allowed', 'removed']);
    const foreign = await aRoom(db, ['foreign']);
    const clock = aMovableClock(new Date());
    const people = [room.members['allowed'], room.members['removed'], foreign.members['foreign']];
    const identities = await Promise.all(
      people.map(async (person) => {
        if (person === undefined) throw new Error('Missing personal batch member');
        const session = await aSession(db, clock, person.userId);
        return { userId: person.userId, sessionId: session.sessionId };
      }),
    );
    const removed = identities[1];
    if (removed === undefined) throw new Error('Missing removed member');
    await db
      .updateTable('channels')
      .set({ type: 'private' })
      .where('id', '=', room.channelId)
      .execute();
    await db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', removed.userId)
      .execute();
    const project = workspaceFrameProjector(db, clock, () => NO_SESSION_LIFETIME);
    const frame: ServerFrame = {
      event: 'TYPING',
      ts: 1,
      data: { channelId: room.channelId, userId: removed.userId, ttlMs: 5000 },
    };
    const deliver = async (): Promise<Awaited<ReturnType<typeof project>>[]> =>
      await Promise.all(
        identities.map(
          async (identity) =>
            await project(identity, [room.channelId], frame, new AbortController().signal),
        ),
      );
    const results = await deliver();
    expect(results[0]).toEqual({ frame });
    for (const result of results.slice(1))
      expect(result).toEqual({ workspaceId: room.workspaceId, channelIds: [] });
    await db
      .updateTable('workspaces')
      .set({ access_policy_epoch: '1' })
      .where('id', '=', room.workspaceId)
      .execute();
    for (const result of await deliver())
      expect(result).toEqual({ workspaceId: room.workspaceId, channelIds: [] });
  });
});

test('integration: distinct counter frames use bounded routing reads and late recipients recheck visibility', async () => {
  await withRollback(async (db) => {
    const room = await aRoom(db, ['counter']);
    const person = room.members['counter'];
    if (person === undefined) throw new Error('Missing counter member');
    const clock = aMovableClock(new Date());
    const session = await aSession(db, clock, person.userId);
    const identity = { userId: person.userId, sessionId: session.sessionId };
    let reads = 0;
    const counted = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: (args) => {
        reads++;
        return Promise.resolve(args.result);
      },
    });
    const project = workspaceFrameProjector(counted, clock, () => NO_SESSION_LIFETIME);
    const frames: ServerFrame[] = Array.from({ length: 48 }, (_, unreadCount) => ({
      event: 'CHANNEL_STATE',
      ts: 1,
      version: 1,
      data: {
        channelId: room.channelId,
        state: { lastReadMessageId: null, unreadCount, unreadMentionCount: 0 },
      },
    }));
    const results = await Promise.all(
      frames.map(
        async (frame) =>
          await project(identity, [room.channelId], frame, new AbortController().signal),
      ),
    );
    expect(reads).toBeLessThanOrEqual(2);
    expect(results).toEqual(frames.map((frame) => ({ frame })));
    await db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', person.userId)
      .execute();
    const first = frames[0];
    if (first === undefined) throw new Error('Missing counter frame');
    reads = 0;
    expect(await project(identity, [room.channelId], first, new AbortController().signal)).toEqual({
      workspaceId: room.workspaceId,
      channelIds: [],
    });
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(2);
  });
});
