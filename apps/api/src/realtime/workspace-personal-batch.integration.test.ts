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
