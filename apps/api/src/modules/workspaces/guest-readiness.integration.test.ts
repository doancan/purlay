/** Deployment attestation is explicit: a capable API does not prove that every reader was updated. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createGuestInvitation } from './guest-invitations';
import { makeAndMailGuestInvitation } from './invitation-mail';
import { acceptInvitation, createInvitation } from './invitations';
import { attempt } from '../../testing/attempt';
import { noWorkspaceChannels } from './channels-port';

afterAll(closeIntegrationDatabase);

describe('integration: explicit guest reader rollout readiness', () => {
  test('guest admission defaults closed, explicit readiness admits, and ordinary invitations still work while closed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const recipient = await aUserRow(db, 'rollout-guest');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', recipient.userId)
        .execute();
      const clock = fixedClock(new Date());
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const invitation = await createGuestInvitation(
        db,
        clock,
        owner,
        { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            invitation.token,
            undefined,
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('PEERS_BEHIND');
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            invitation.token,
            undefined,
            chatWorkspaceChannels,
            false,
          ),
        ),
      ).toBe('PEERS_BEHIND');
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', recipient.userId)
            .execute()
        ).length,
      ).toBe(0);
      expect(
        (
          await db
            .selectFrom('channel_members')
            .select('channel_id')
            .where('user_id', '=', recipient.userId)
            .execute()
        ).length,
      ).toBe(0);
      const joined = await acceptInvitation(
        db,
        clock,
        recipient.userId,
        invitation.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      expect(joined.membership.access?.kind).toBe('guest');
      const again = await acceptInvitation(
        db,
        clock,
        recipient.userId,
        invitation.token,
        undefined,
        chatWorkspaceChannels,
        false,
      );
      expect(again.memberIds).toHaveLength(0);
      expect(again.membership.access?.kind).toBe('guest');
      const normal = await createInvitation(db, clock, owner);
      const another = await aUserRow(db, 'rollout-normal');
      const full = await acceptInvitation(db, clock, another.userId, normal.token);
      expect(full.membership.access?.kind === 'guest').toBe(false);
    });
  });

  test('initial named guest mint/mail refuses before any invitation or quota row without rollout readiness', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      expect(
        await attempt(db, () =>
          makeAndMailGuestInvitation(
            db,
            fixedClock(new Date()),
            owner,
            { email: 'named@example.test', channelIds: [room.channelId], accessExpiresAt: null },
            { on: false, appUrl: 'https://purlay.test' },
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('PEERS_BEHIND');
      expect(
        (
          await db
            .selectFrom('workspace_invitations')
            .select('id')
            .where('workspace_id', '=', room.workspaceId)
            .execute()
        ).length,
      ).toBe(0);
    });
  });

  test('guest creation is absent with its conversation module, including during a closed rollout', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      for (const ready of [false, true]) {
        expect(
          await attempt(db, () =>
            makeAndMailGuestInvitation(
              db,
              fixedClock(new Date()),
              owner,
              { email: 'named@example.test', channelIds: [room.channelId], accessExpiresAt: null },
              { on: false, appUrl: 'https://purlay.test' },
              noWorkspaceChannels,
              ready,
            ),
          ),
        ).toBe('ROUTE_NOT_FOUND');
      }
    });
  });
});
