/** A stopped/absent chat runtime and legacy restored rows must not resurrect private guest grants. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireChannelById } from '../../features/chat/channels/guard';
import { createChannel } from '../../features/chat/channels/channels';
import { addMember } from '../../features/chat/channels/members';
import { leaveChannel } from '../../features/chat/channels/settings';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { sendMessage, messageHistory } from '../../features/chat/messages/messages';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { attempt } from '../../testing/attempt';
import { noWorkspaceChannels } from './channels-port';
import { createGuestInvitation } from './guest-invitations';
import { createInvitation, acceptInvitation } from './invitations';
import { removeMember } from './members';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const setup = async (
  db: Transaction,
  kind: 'member' | 'guest',
): Promise<{
  readonly owner: Awaited<ReturnType<typeof requireWorkspaceMembership>>;
  readonly target: Awaited<ReturnType<typeof aUserRow>>;
  readonly publicId: string;
  readonly privateId: string;
  readonly otherId: string;
  readonly otherHistoryId: string;
  readonly historyId: string;
}> => {
  const room = await aRoom(db, ['owner']);
  const clock = fixedClock(new Date(Date.now() - 60_000));
  const owner = await requireWorkspaceMembership(
    db,
    room.members['owner']?.userId ?? '',
    room.workspaceId,
  );
  const target = await aUserRow(db, 'orphaned-access');
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', target.userId)
    .execute();
  const privateChannel = await createChannel(db, clock, owner, {
    name: 'private-before-removal',
    type: 'private',
  });
  const history = await createChannel(db, clock, owner, {
    name: 'previously-left',
    type: 'public',
  });
  await leaveChannel(db, await requireChannelById(db, owner.userId, history.id));
  const invitation =
    kind === 'guest'
      ? await createGuestInvitation(
          db,
          clock,
          owner,
          {
            email: target.email,
            channelIds: [room.channelId, privateChannel.id],
            accessExpiresAt: null,
          },
          chatWorkspaceChannels,
        )
      : await createInvitation(db, clock, owner);
  await acceptInvitation(
    db,
    clock,
    target.userId,
    invitation.token,
    undefined,
    chatWorkspaceChannels,
    true,
  );
  if (kind === 'member')
    for (const channelId of [room.channelId, privateChannel.id])
      await addMember(
        db,
        clock,
        await requireChannelById(db, owner.userId, channelId),
        target.userId,
      );
  await db
    .insertInto('channel_departures')
    .values({ channel_id: history.id, user_id: target.userId, reason: 'left' })
    .execute();
  const other = await aRoom(db, ['owner']);
  const otherOwner = await requireWorkspaceMembership(
    db,
    other.members['owner']?.userId ?? '',
    other.workspaceId,
  );
  const otherInvite = await createInvitation(db, clock, otherOwner);
  await acceptInvitation(
    db,
    clock,
    target.userId,
    otherInvite.token,
    undefined,
    chatWorkspaceChannels,
    true,
  );
  await addMember(
    db,
    clock,
    await requireChannelById(db, otherOwner.userId, other.channelId),
    target.userId,
  );
  const otherHistory = await createChannel(db, clock, otherOwner, {
    name: 'other-past-conversation',
    type: 'public',
  });
  await db
    .insertInto('channel_departures')
    .values({ channel_id: otherHistory.id, user_id: target.userId, reason: 'left' })
    .execute();
  return {
    owner,
    target,
    publicId: room.channelId,
    privateId: privateChannel.id,
    otherId: other.channelId,
    otherHistoryId: otherHistory.id,
    historyId: history.id,
  };
};

describe('integration: workspace removal and orphaned conversation grants', () => {
  test.each(['member', 'guest'] as const)(
    '%s removal without a chat port clears this workspace alone, including remembered departures',
    async (kind) => {
      await withRollback(async (db) => {
        const { owner, target, publicId, privateId, historyId, otherId, otherHistoryId } =
          await setup(db, kind);
        await removeMember(db, fixedClock(new Date()), owner, target.userId, noWorkspaceChannels);
        const grants = await db
          .selectFrom('channel_members')
          .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
          .select('channels.id')
          .where('channel_members.user_id', '=', target.userId)
          .where('channels.workspace_id', '=', owner.workspaceId)
          .execute();
        expect(grants.map((row) => row.id)).toEqual([]);
        const departures = await db
          .selectFrom('channel_departures')
          .innerJoin('channels', 'channels.id', 'channel_departures.channel_id')
          .select('channels.id')
          .where('channel_departures.user_id', '=', target.userId)
          .where('channels.workspace_id', '=', owner.workspaceId)
          .execute();
        expect(departures.map((row) => row.id)).toEqual([]);
        expect(
          await db
            .selectFrom('channel_members')
            .select('id')
            .where('channel_id', 'in', [publicId, privateId])
            .where('user_id', '=', owner.userId)
            .execute(),
        ).toHaveLength(2);
        expect(
          await db
            .selectFrom('channel_departures')
            .select('channel_id')
            .where('channel_id', '=', historyId)
            .where('user_id', '=', owner.userId)
            .execute(),
        ).toHaveLength(1);
        expect(
          await db
            .selectFrom('channel_members')
            .select('id')
            .where('channel_id', '=', otherId)
            .where('user_id', '=', target.userId)
            .execute(),
        ).toHaveLength(1);
        expect(
          await db
            .selectFrom('channel_departures')
            .select('channel_id')
            .where('channel_id', '=', otherHistoryId)
            .where('user_id', '=', target.userId)
            .execute(),
        ).toHaveLength(1);
      });
    },
  );

  test('a fresh named admission replaces legacy orphan grants instead of reopening an unselected private conversation', async () => {
    await withRollback(async (db) => {
      const { owner, target, publicId, privateId, otherId } = await setup(db, 'guest');
      const clock = fixedClock(new Date(Date.now() - 1_000));
      await removeMember(db, clock, owner, target.userId, noWorkspaceChannels);
      // A restore/older runtime can have left this valid legacy row without a workspace membership.
      await db
        .insertInto('channel_members')
        .values({
          channel_id: privateId,
          user_id: target.userId,
          joined_at: new Date(clock.now().getTime() - 60_000),
        })
        .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
        .execute();
      const admission = fixedClock(new Date(clock.now().getTime() + 1));
      const invite = await createGuestInvitation(
        db,
        admission,
        owner,
        { email: target.email, channelIds: [publicId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      await acceptInvitation(
        db,
        admission,
        target.userId,
        invite.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const sentAt = new Date(admission.now().getTime() + 10);
      await sendMessage(
        db,
        fixedClock(sentAt),
        await requireChannelById(db, owner.userId, privateId),
        { id: messageId(sentAt), content: 'Never assigned by this invitation' },
      );
      expect(
        await attempt(
          db,
          async () =>
            await messageHistory(db, await requireChannelById(db, target.userId, privateId), {}),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      expect((await requireChannelById(db, target.userId, publicId)).channelId).toBe(publicId);
      expect((await requireChannelById(db, target.userId, otherId)).channelId).toBe(otherId);
    });
  });
});
