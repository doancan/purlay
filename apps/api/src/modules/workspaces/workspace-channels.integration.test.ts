/**
 * What the workspace code does with no chat to ask about its channels, and with chat's answer (D-250).
 *
 * The workspace code names no channel: it asks a port. With chat's, the answers are what they were; with the
 * null one — there are no channels — removing a member, setting a window and asking for a deletion still
 * work and say there is nobody to tell about a channel.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { requireDeletionMembership, requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { aRoom } from '../../testing/rooms';
import { createChannel } from '../../features/chat/channels/channels';
import { noWorkspaceChannels } from './channels-port';
import { askToDelete } from './deletion';
import { removeMember } from './members';
import { readRetention, setRetention } from './retention';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const idOf = (room: Awaited<ReturnType<typeof aRoom>>, name: string): string => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found.userId;
};

describe('integration: a workspace and its channels, asked through the port', () => {
  test('with chat, a removed member leaves every channel and is told which they could see', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const alice = await requireWorkspaceMembership(
      cloned.db,
      idOf(room, 'alice'),
      room.workspaceId,
    );
    const { channelIds } = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await removeMember(transaction, clock, alice, idOf(room, 'bob'), chatWorkspaceChannels),
    );
    expect(channelIds).toEqual([room.channelId]);
    const left = await cloned.db
      .selectFrom('channel_members')
      .select('user_id')
      .where('user_id', '=', idOf(room, 'bob'))
      .execute();
    expect(left).toEqual([]);
  });

  test('with no chat, the same removal works and names no channel', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const alice = await requireWorkspaceMembership(
      cloned.db,
      idOf(room, 'alice'),
      room.workspaceId,
    );
    const { channelIds } = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await removeMember(transaction, clock, alice, idOf(room, 'bob'), noWorkspaceChannels),
    );
    expect(channelIds).toEqual([]);
    const stillMember = await cloned.db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', idOf(room, 'bob'))
      .execute();
    expect(stillMember).toEqual([]);
  });

  test('the window counts the channels that keep longer with chat, and none without', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await requireWorkspaceMembership(
      cloned.db,
      idOf(room, 'alice'),
      room.workspaceId,
    );
    // Four channels against a window of 60 days: one kept forever, two with a floor past the window, one with
    // a floor inside it (a floor is at least 30). Three keep longer; a comparison read the other way round
    // counts the forever one and the inside one, which is two.
    const made = await atomicallyOn(cloned.db)(async (transaction) => [
      await createChannel(transaction, clock, alice, { name: 'floor-past-a' }),
      await createChannel(transaction, clock, alice, { name: 'floor-past-b' }),
      await createChannel(transaction, clock, alice, { name: 'floor-inside' }),
    ]);
    const floors = [90, 120, 30];
    await cloned.db
      .updateTable('channels')
      .set({ retain_forever: true })
      .where('id', '=', room.channelId)
      .execute();
    for (const [index, channel] of made.entries()) {
      await cloned.db
        .updateTable('channels')
        .set({ min_retention_days: floors[index] ?? null })
        .where('id', '=', channel.id)
        .execute();
    }
    const withChat = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await setRetention(transaction, clock, alice, 60, chatWorkspaceChannels),
    );
    expect(withChat).toEqual({ retentionDays: 60, channelsKeptLonger: 3 });
    expect(await readRetention(cloned.db, alice, chatWorkspaceChannels)).toEqual(withChat);
    expect(await readRetention(cloned.db, alice, noWorkspaceChannels)).toEqual({
      retentionDays: 60,
      channelsKeptLonger: 0,
    });
  });

  test('asking for a deletion tells the channels with chat, and none without', async () => {
    const withChat = await aRoom(cloned.db, ['owner']);
    const ownerOne = await requireDeletionMembership(
      cloned.db,
      idOf(withChat, 'owner'),
      withChat.workspaceId,
    );
    const asked = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await askToDelete(transaction, clock, ownerOne, 'Room', chatWorkspaceChannels),
    );
    expect(asked.channelIds).toEqual([withChat.channelId]);

    const without = await aRoom(cloned.db, ['owner']);
    const ownerTwo = await requireDeletionMembership(
      cloned.db,
      idOf(without, 'owner'),
      without.workspaceId,
    );
    const askedNone = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await askToDelete(transaction, clock, ownerTwo, 'Room', noWorkspaceChannels),
    );
    expect(askedNone.channelIds).toEqual([]);
    expect(askedNone.memberIds).toEqual([idOf(without, 'owner')]);
  });
});
