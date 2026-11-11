/** Complete named guest creation and rollout refusal through actual HTTP handlers. */
import { afterAll, describe, expect, test } from 'bun:test';
import { withRollback, closeIntegrationDatabase } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  CreatedGuestInvitation,
  CreatedInvitation,
  GuestInvitationAvailability,
  InvitationPreview,
  Membership,
  UpdatedGuestAccess,
} from '@purlay/types';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { createGuestInvitation } from '../../modules/workspaces/guest-invitations';
import { acceptInvitation } from '../../modules/workspaces/invitations';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createApp } from './app';

afterAll(closeIntegrationDatabase);

describe('integration: named guest invitation HTTP creation and reactivation', () => {
  test.each([false, true])(
    'HTTP guest creation and named acceptance use the actual rollout flag ready=%s',
    async (ready) => {
      await withRollback(async (db) => {
        const clock = fixedClock(new Date());
        const room = await aRoom(db, ['owner']);
        const manager = await aSignedInUser(db, clock, 'guest-invite-manager');
        await db
          .insertInto('workspace_members')
          .values({ workspace_id: room.workspaceId, user_id: manager.userId, role: 'owner' })
          .execute();
        const recipient = await aSignedInUser(db, clock, 'guest-invite-target');
        const row = await db
          .updateTable('users')
          .set({ email_verified: true })
          .where('id', '=', recipient.userId)
          .returning('email')
          .executeTakeFirstOrThrow();
        const app = createApp(
          testDependencies({
            database: db,
            clock,
            config: testConfig({ GUEST_ACCESS_READY: ready }),
          }),
        );
        const call = async (
          cookie: string,
          method: string,
          path: string,
          body?: unknown,
        ): Promise<Response> =>
          await app.handle(
            new Request('https://purlay.test' + path, {
              method,
              headers: {
                cookie,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        const path = `/api/workspaces/${room.workspaceId}/guest-invitations`;
        const capability = await call(manager.cookie, 'GET', path);
        expect(capability.status).toBe(200);
        const availability: unknown = await capability.json();
        expect(Value.Check(GuestInvitationAvailability, availability)).toBe(true);
        expect(availability).toEqual({ enabled: ready, email: false });
        const input = {
          email: row.email.toUpperCase(),
          channelIds: [room.channelId],
          accessExpiresAt: null,
          locale: 'tr' as const,
        };
        const made = await call(manager.cookie, 'POST', path, input);
        expect(made.status).toBe(ready ? 201 : 409);
        let token: string;
        if (ready) {
          const created: unknown = await made.json();
          if (!Value.Check(CreatedGuestInvitation, created))
            throw new Error('Invalid named guest creation response');
          expect(created.guest.email).toBe(row.email);
          expect(created.invitation.guest).toEqual({ channelCount: 1, accessExpiresAt: null });
          expect(created.mail).toEqual([{ address: row.email, outcome: 'unavailable' }]);
          token = created.token;
        } else {
          expect(
            (
              await db
                .selectFrom('workspace_invitations')
                .select('id')
                .where('workspace_id', '=', room.workspaceId)
                .execute()
            ).length,
          ).toBe(0);
          const actor = await requireWorkspaceMembership(db, manager.userId, room.workspaceId);
          token = (
            await createGuestInvitation(
              db,
              clock,
              actor,
              { ...input, email: row.email },
              chatWorkspaceChannels,
            )
          ).token;
        }
        const accepted = await call(recipient.cookie, 'POST', '/api/invitations/accept', { token });
        expect(accepted.status).toBe(ready ? 200 : 409);
        if (ready) {
          const membership: unknown = await accepted.json();
          if (!Value.Check(Membership, membership))
            throw new Error('Invalid accepted guest membership');
          expect(membership.access?.kind).toBe('guest');
          const preview = await call(recipient.cookie, 'POST', '/api/invitations/preview', {
            token,
          });
          expect(preview.status).toBe(200);
          const shown: unknown = await preview.json();
          if (!Value.Check(InvitationPreview, shown)) throw new Error('Invalid invitation preview');
          expect(shown.guest).toEqual({ channelCount: 1, accessExpiresAt: null });
        } else {
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
        }
        const ordinary = await call(
          manager.cookie,
          'POST',
          `/api/workspaces/${room.workspaceId}/invitations`,
          {},
        );
        expect(ordinary.status).toBe(201);
        const full: unknown = await ordinary.json();
        if (!Value.Check(CreatedInvitation, full)) throw new Error('Invalid ordinary invitation');
        expect(full.invitation.guest === undefined).toBe(true);
        // Re-admission is independently guarded even when the original invitation was already accepted.
        await acceptInvitation(
          db,
          clock,
          recipient.userId,
          token,
          undefined,
          chatWorkspaceChannels,
          true,
        );
        await db
          .updateTable('workspace_members')
          .set({
            joined_at: new Date(clock.now().getTime() - 120_000),
            guest_since: new Date(clock.now().getTime() - 120_000),
            guest_expires_at: new Date(clock.now().getTime() - 60_000),
          })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .execute();
        const expired = await db
          .selectFrom('workspace_members')
          .selectAll()
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .executeTakeFirstOrThrow();
        const renewed = await call(
          manager.cookie,
          'PATCH',
          `/api/workspaces/${room.workspaceId}/guests/${recipient.userId}`,
          { accessExpiresAt: null },
        );
        expect(renewed.status).toBe(ready ? 200 : 409);
        const renewal: unknown = await renewed.json();
        if (ready) {
          if (!Value.Check(UpdatedGuestAccess, renewal))
            throw new Error('Invalid renewed guest access');
          expect(renewal.access).toEqual({
            kind: 'guest',
            historySince: clock.now().toISOString(),
            expiresAt: null,
          });
          expect(renewal.joinedAt).toBe(clock.now().toISOString());
        } else {
          expect(renewal).toMatchObject({ error: { code: 'PEERS_BEHIND' } });
          expect(
            await db
              .selectFrom('workspace_members')
              .selectAll()
              .where('workspace_id', '=', room.workspaceId)
              .where('user_id', '=', recipient.userId)
              .executeTakeFirstOrThrow(),
          ).toEqual(expired);
        }
      });
    },
  );
});
