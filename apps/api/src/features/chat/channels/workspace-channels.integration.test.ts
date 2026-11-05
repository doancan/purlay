/**
 * What chat answers for a workspace's channels when a person leaves the workspace (D-250), in a database where chat's own
 * set was never applied — the core alone, or another module's set on it. The answer is held whether chat runs or not, so it
 * must not name a table that set makes: `channel_departures` is chat's (`chat/0006`), and a person's removal from a
 * workspace answered 500 where it was absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  cloneIntegrationDatabase,
  DROP_HOOK_MS,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { aRoom } from '../../../testing/rooms';
import { chatWorkspaceChannels } from './workspace-channels';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

describe('integration: leaving a workspace, with and without the set that keeps how people left channels', () => {
  test('forgets the channels a person was in, and how they left one, where the table is there', async () => {
    const room = await aRoom(cloned.db, ['ayşe', 'burak']);
    const userId = room.members['burak']?.userId ?? '';
    await sql`insert into channel_departures (channel_id, user_id, reason)
      values (${room.channelId}, ${userId}, 'left')`.execute(cloned.db);
    const left = await chatWorkspaceChannels.leaveAll(cloned.db, room.workspaceId, userId);
    expect(left).toContain(room.channelId);
    const kept = await sql`select 1 from channel_departures where user_id = ${userId}`.execute(
      cloned.db,
    );
    expect(kept.rows).toEqual([]);
  });

  test('still leaves the channels where chat’s set was never applied, which has no such table', async () => {
    await sql`drop table channel_departures`.execute(cloned.db);
    const room = await aRoom(cloned.db, ['can', 'deniz']);
    const userId = room.members['deniz']?.userId ?? '';
    const left = await chatWorkspaceChannels.leaveAll(cloned.db, room.workspaceId, userId);
    expect(left).toContain(room.channelId);
    const member = await sql`select 1 from channel_members where user_id = ${userId}`.execute(
      cloned.db,
    );
    expect(member.rows).toEqual([]);
  });
});
