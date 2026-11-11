/** Guest administrators can page current/expired memberships without exposing private scope identities. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { messageId, WorkspaceGuestPage } from '@purlay/types';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { fixedClock } from '../../platform/clock';
import { attempt } from '../../testing/attempt';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { createChannel } from '../../features/chat/channels/channels';
import { openConversation } from '../../features/chat/channels/direct-messages';
import { requireChannelById } from '../../features/chat/channels/guard';
import { sendMessage, messageHistory } from '../../features/chat/messages/messages';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { listWorkspaceGuests } from './guests';
import { updateGuestAccess } from './guest-access';
import { membersIn } from './workspaces';
import { changeRole } from './members';
import { createGuestInvitation } from './guest-invitations';
import { acceptInvitation } from './invitations';
import { noWorkspaceChannels, type WorkspaceChannels } from './channels-port';
import { withinRequest } from '../../platform/logging';
import { effectiveModules } from '../../platform/module-kit/entitlement';
import { aMovableClock } from '../../testing/doubles';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const setup = async (
  db: Transaction,
): Promise<{
  readonly owner: Awaited<ReturnType<typeof requireWorkspaceMembership>>;
  readonly memberId: string;
  readonly guestIds: readonly string[];
  readonly channelId: string;
  readonly privateId: string;
  readonly privateAdminId: string;
}> => {
  const room = await aRoom(db, ['owner', 'member', 'private-admin']);
  const owner = await requireWorkspaceMembership(
    db,
    room.members['owner']?.userId ?? '',
    room.workspaceId,
  );
  const memberId = room.members['member']?.userId ?? '';
  const privateAdminId = room.members['private-admin']?.userId ?? '';
  const privateChannel = await createChannel(
    db,
    fixedClock(new Date()),
    await requireWorkspaceMembership(db, privateAdminId, room.workspaceId),
    { name: 'confidential-scope', type: 'private' },
  );
  const guestIds: string[] = [];
  const at = new Date(Date.now() - 60_000);
  for (const displayName of ['Görkem Tedarikçi', 'Supplier 50%_offer', 'Expired partner']) {
    const user = await aUserRow(db, 'managed-guest');
    await db
      .updateTable('users')
      .set({ email_verified: true, display_name: displayName })
      .where('id', '=', user.userId)
      .execute();
    const made = await createGuestInvitation(
      db,
      fixedClock(at),
      owner,
      { email: user.email, channelIds: [room.channelId], accessExpiresAt: null },
      chatWorkspaceChannels,
    );
    await acceptInvitation(
      db,
      fixedClock(at),
      user.userId,
      made.token,
      undefined,
      chatWorkspaceChannels,
      true,
    );
    guestIds.push(user.userId);
  }
  const hiddenGuest = guestIds[0] ?? '';
  await db
    .updateTable('workspace_members')
    .set({ role: 'admin' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', privateAdminId)
    .execute();
  const privateAdmin = await requireWorkspaceMembership(db, privateAdminId, room.workspaceId);
  const guests = chatWorkspaceChannels.guests;
  if (guests === undefined) throw new Error('Missing guest conversation adapter');
  await guests.grant(db, fixedClock(at), privateAdmin, hiddenGuest, [privateChannel.id]);
  await db
    .updateTable('workspace_members')
    .set({ guest_expires_at: new Date(at.getTime() + 1_000) })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', guestIds[2] ?? '')
    .execute();
  return {
    owner,
    memberId,
    guestIds,
    channelId: room.channelId,
    privateId: privateChannel.id,
    privateAdminId,
  };
};

describe('integration: workspace guest administration', () => {
  test('the general directory and same-role receipt identify guests without revealing their expiry or history floor', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId } = await setup(db);
      const directory = await membersIn(db, owner, chatWorkspaceChannels);
      const guest = directory.find((row) => row.user.id === guestIds[0]);
      expect(guest).toMatchObject({ accessKind: 'guest', role: 'member' });
      expect(JSON.stringify(guest)).not.toContain('historySince');
      expect(JSON.stringify(guest)).not.toContain('expiresAt');
      expect(directory.find((row) => row.user.id === memberId)).not.toHaveProperty('accessKind');
      expect(
        await changeRole(db, fixedClock(new Date()), owner, guestIds[0] ?? '', 'member'),
      ).toMatchObject({ accessKind: 'guest' });
    });
  });

  test('a selected private channel must still be visible when the prepared edit is applied', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds } = await setup(db);
      const privateChannel = await createChannel(db, fixedClock(new Date()), owner, {
        name: 'scope-visibility-change',
        type: 'private',
      });
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      const prepared = await port.prepareEdit(db, owner, guestIds[0] ?? '', [privateChannel.id]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', privateChannel.id)
        .where('user_id', '=', owner.userId)
        .execute();
      expect(await attempt(db, () => prepared.apply(new Date(), false))).toBe('CHANNEL_NOT_FOUND');
    });
  });
  test('selection rejects a DM and another workspace even when the administrator can read both', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId } = await setup(db);
      const target = guestIds[0] ?? '';
      const clock = fixedClock(new Date());
      const dm = await openConversation(db, clock, owner, [memberId]);
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            target,
            { channelIds: [dm.channel.id] },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      const other = await aRoom(db, ['owner']);
      await db
        .insertInto('workspace_members')
        .values([
          { workspace_id: other.workspaceId, user_id: owner.userId, role: 'member' },
          { workspace_id: other.workspaceId, user_id: target, role: 'member' },
        ])
        .execute();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.channelId, user_id: target })
        .execute();
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            target,
            { channelIds: [other.channelId] },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      const changed = await updateGuestAccess(
        db,
        clock,
        owner,
        target,
        { channelIds: [] },
        chatWorkspaceChannels,
        true,
      );
      expect(changed.guest).toMatchObject({ channelIds: [], hiddenChannelCount: 1 });
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('user_id', '=', target)
          .where('channel_id', '=', other.channelId)
          .executeTakeFirst(),
      ).toBeDefined();
    });
  });
  test('core refuses stopped scope before delegating and rechecks a stop committed during preparation', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId } = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      const member = await requireWorkspaceMembership(db, memberId, owner.workspaceId);
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            fixedClock(new Date()),
            member,
            guestIds[0] ?? '',
            {},
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('FORBIDDEN');
      let stopped = true;
      const unavailable: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...port,
          prepareEdit: () => Promise.reject(new Error('A stopped module must not be called')),
        },
      };
      const later: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...port,
          prepareEdit: () => {
            stopped = true;
            return Promise.resolve({
              apply: () =>
                Promise.resolve({
                  visibleIds: [],
                  hiddenCount: 0,
                  previousIds: [],
                  removedIds: [],
                  addedCount: 0,
                  changed: false,
                }),
            });
          },
        },
      };
      await withinRequest(
        {
          requestId: 'guest-edit-stop-boundary',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(stopped ? ['chat'] : []),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          expect(
            await attempt(db, () =>
              updateGuestAccess(
                db,
                fixedClock(new Date()),
                owner,
                guestIds[0] ?? '',
                { channelIds: [] },
                unavailable,
                true,
              ),
            ),
          ).toBe('ROUTE_NOT_FOUND');
          stopped = false;
          expect(
            await attempt(db, () =>
              updateGuestAccess(
                db,
                fixedClock(new Date()),
                owner,
                guestIds[0] ?? '',
                { channelIds: [] },
                later,
                true,
              ),
            ),
          ).toBe('ROUTE_NOT_FOUND');
        },
      );
    });
  });

  test('a prepared scope still requires current administrator authority and an available module', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, privateAdminId } = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      const prepared = await port.prepareEdit(db, owner, guestIds[0] ?? '', []);
      await withinRequest(
        {
          requestId: 'guest-edit-module-stopped',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(['chat']),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          expect(await attempt(db, () => prepared.apply(new Date(), false))).toBe(
            'ROUTE_NOT_FOUND',
          );
          expect(
            await attempt(db, () =>
              updateGuestAccess(
                db,
                fixedClock(new Date()),
                owner,
                guestIds[0] ?? '',
                { channelIds: [] },
                chatWorkspaceChannels,
                true,
              ),
            ),
          ).toBe('ROUTE_NOT_FOUND');
        },
      );
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', owner.workspaceId)
        .where('user_id', '=', privateAdminId)
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', owner.workspaceId)
        .where('user_id', '=', owner.userId)
        .execute();
      expect(await attempt(db, () => prepared.apply(new Date(), false))).toBe('FORBIDDEN');
      const doNotDelegate: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...port,
          prepareEdit: () =>
            Promise.reject(new Error('A demoted actor must not reach private scope preparation')),
        },
      };
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            fixedClock(new Date()),
            owner,
            guestIds[0] ?? '',
            { channelIds: [] },
            doNotDelegate,
            true,
          ),
        ),
      ).toBe('FORBIDDEN');
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            fixedClock(new Date()),
            owner,
            guestIds[0] ?? '',
            { channelIds: [] },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('the scope port refuses an ordinary target and catches a grant changed after preparation', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId, channelId } = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      const ordinary = await port.prepareEdit(db, owner, memberId, []);
      expect(await attempt(db, () => ordinary.apply(new Date(), false))).toBe('USER_NOT_FOUND');
      const elsewhere = await setup(db);
      const foreign = await port.prepareEdit(db, owner, elsewhere.guestIds[0] ?? '', []);
      expect(await attempt(db, () => foreign.apply(new Date(), false))).toBe('USER_NOT_FOUND');
      const target = guestIds[0] ?? '';
      const prepared = await port.prepareEdit(db, owner, target, [channelId]);
      const extra = await createChannel(db, fixedClock(new Date()), owner, {
        name: 'concurrent-scope',
        type: 'public',
      });
      await port.grant(db, fixedClock(new Date()), owner, target, [extra.id]);
      expect(await attempt(db, () => prepared.apply(new Date(), false))).toBe('VALIDATION_FAILED');
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('user_id', '=', target)
          .where('channel_id', '=', extra.id)
          .executeTakeFirst(),
      ).toBeDefined();
    });
  });

  test('a total channel bound includes assignments hidden from the editing administrator', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId } = await setup(db);
      const ids = [channelId];
      for (let index = 0; index < 19; index += 1)
        ids.push(
          (
            await createChannel(db, fixedClock(new Date()), owner, {
              name: `bounded-guest-${String(index)}`,
              type: 'public',
            })
          ).id,
        );
      expect(
        (
          await updateGuestAccess(
            db,
            fixedClock(new Date()),
            owner,
            guestIds[0] ?? '',
            { channelIds: ids.slice(0, 19) },
            chatWorkspaceChannels,
            true,
          )
        ).guest.channelIds,
      ).toHaveLength(19);
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            fixedClock(new Date()),
            owner,
            guestIds[0] ?? '',
            { channelIds: ids },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        (await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).data.find(
          (row) => row.user.id === guestIds[0],
        ),
      ).toMatchObject({ channelIds: ids.slice(0, 19).sort(), hiddenChannelCount: 1 });
    });
  });

  test('core rechecks the administrator after preparation even when the module does not enforce it', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, privateAdminId } = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', owner.workspaceId)
        .where('user_id', '=', privateAdminId)
        .execute();
      const delegated: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...port,
          prepareEdit: async () => {
            await db
              .updateTable('workspace_members')
              .set({ role: 'member' })
              .where('workspace_id', '=', owner.workspaceId)
              .where('user_id', '=', owner.userId)
              .execute();
            return {
              apply: () =>
                Promise.resolve({
                  visibleIds: [],
                  hiddenCount: 0,
                  previousIds: [],
                  removedIds: [],
                  addedCount: 0,
                  changed: false,
                }),
            };
          },
        },
      };
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            fixedClock(new Date()),
            owner,
            guestIds[0] ?? '',
            { accessExpiresAt: null },
            delegated,
            true,
          ),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('expiry is checked after preparation, and an audit failure rolls back scope and access together', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId } = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest conversation adapter');
      const target = guestIds[0] ?? '';
      const clock = aMovableClock(new Date());
      const expiry = new Date(clock.now().getTime() + 1_000).toISOString();
      const slow: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...port,
          prepareEdit: async (...args) => {
            const result = await port.prepareEdit(...args);
            clock.advance(2_000);
            return result;
          },
        },
      };
      expect(
        await attempt(db, () =>
          updateGuestAccess(db, clock, owner, target, { accessExpiresAt: expiry }, slow, true),
        ),
      ).toBe('VALIDATION_FAILED');
      await sql`create function reject_guest_change_audit() returns trigger language plpgsql as $$
        begin if new.action = 'member.guest_access_changed' then raise exception 'guest change audit failure'; end if; return new; end $$`.execute(
        db,
      );
      await sql`create trigger reject_guest_change_audit before insert on audit_log for each row execute function reject_guest_change_audit()`.execute(
        db,
      );
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            target,
            {
              channelIds: [],
              accessExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
            },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toContain('guest change audit failure');
      expect(
        (await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).data.find(
          (row) => row.user.id === target,
        ),
      ).toMatchObject({
        channelIds: [channelId],
        hiddenChannelCount: 1,
        access: { expiresAt: null },
      });
    });
  });

  test('scope edits preserve hidden assignments and clear only the visible selection', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, privateId } = await setup(db);
      const target = guestIds[0] ?? '';
      const changed = await updateGuestAccess(
        db,
        fixedClock(new Date()),
        owner,
        target,
        { channelIds: [] },
        chatWorkspaceChannels,
        true,
      );
      expect(changed.guest).toMatchObject({ channelIds: [], hiddenChannelCount: 1 });
      expect(changed.changed).toBe(true);
      const rows = await db
        .selectFrom('channel_members')
        .select('channel_id')
        .where('user_id', '=', target)
        .execute();
      expect(rows.map((row) => row.channel_id)).toEqual([privateId]);
    });
  });

  test('a new grant starts its own history floor and an unchanged edit does not reset it or add audit', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId } = await setup(db);
      const target = guestIds[0] ?? '';
      const clock = fixedClock(new Date());
      const made = await createChannel(db, clock, owner, {
        name: 'new-guest-scope',
        type: 'public',
      });
      const changed = await updateGuestAccess(
        db,
        clock,
        owner,
        target,
        { channelIds: [channelId, made.id] },
        chatWorkspaceChannels,
        true,
      );
      expect(changed.guest.channelIds.sort()).toEqual([channelId, made.id].sort());
      const scope = await db
        .selectFrom('channel_read_scopes')
        .select('unread_since')
        .where('user_id', '=', target)
        .where('channel_id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(new Date(scope.unread_since ?? 0).toISOString()).toBe(clock.now().toISOString());
      const unchanged = await updateGuestAccess(
        db,
        fixedClock(new Date(clock.now().getTime() + 1_000)),
        owner,
        target,
        { channelIds: [made.id, channelId] },
        chatWorkspaceChannels,
        true,
      );
      expect(unchanged.changed).toBe(false);
      expect(unchanged.guest.access).toEqual(changed.guest.access);
      const audit = await db
        .selectFrom('audit_log')
        .select('metadata')
        .where('workspace_id', '=', owner.workspaceId)
        .where('target_id', '=', target)
        .where('action', '=', 'member.guest_access_changed')
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(made.id);
    });
  });

  test('an expired guest stays expired on scope-only edits; explicit extension starts a fresh admission', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId } = await setup(db);
      const target = guestIds[2] ?? '';
      const oldAt = new Date(Date.now() - 30_000);
      const oldId = messageId(oldAt);
      const author = await requireChannelById(db, owner.userId, channelId);
      await sendMessage(db, fixedClock(oldAt), author, {
        id: oldId,
        content: 'Before renewed access',
      });
      await db
        .updateTable('channel_members')
        .set({
          unread_count: 7,
          unread_mention_count: 2,
          last_read_message_id: oldId,
          state_version: 42,
        })
        .where('user_id', '=', target)
        .where('channel_id', '=', channelId)
        .execute();
      await db
        .updateTable('channel_read_scopes')
        .set({ unread_history_from: oldId, thread_read_baseline_id: oldId })
        .where('user_id', '=', target)
        .where('channel_id', '=', channelId)
        .execute();
      const clock = fixedClock(new Date());
      const before = await updateGuestAccess(
        db,
        clock,
        owner,
        target,
        { channelIds: [channelId] },
        chatWorkspaceChannels,
        false,
      );
      expect(new Date(before.guest.access.expiresAt ?? 0).getTime()).toBeLessThan(
        clock.now().getTime(),
      );
      expect(before.changed).toBe(false);
      expect(
        await attempt(db, () => requireWorkspaceMembership(db, target, owner.workspaceId)),
      ).toBe('WORKSPACE_NOT_FOUND');
      const snapshot = async (): Promise<object> => ({
        membership: await db
          .selectFrom('workspace_members')
          .selectAll()
          .where('workspace_id', '=', owner.workspaceId)
          .where('user_id', '=', target)
          .execute(),
        channels: await db
          .selectFrom('channel_members')
          .selectAll()
          .where('user_id', '=', target)
          .orderBy('channel_id')
          .execute(),
        scopes: await db
          .selectFrom('channel_read_scopes')
          .selectAll()
          .where('user_id', '=', target)
          .orderBy('channel_id')
          .execute(),
        audit: await db
          .selectFrom('audit_log')
          .select('id')
          .where('workspace_id', '=', owner.workspaceId)
          .orderBy('id')
          .execute(),
      });
      const unchangedWhileClosed = await snapshot();
      for (const ready of [undefined, false]) {
        expect(
          await attempt(db, () =>
            updateGuestAccess(
              db,
              clock,
              owner,
              target,
              { accessExpiresAt: null },
              chatWorkspaceChannels,
              ready,
            ),
          ),
        ).toBe('PEERS_BEHIND');
        expect(await snapshot()).toEqual(unchangedWhileClosed);
      }
      const changed = await updateGuestAccess(
        db,
        clock,
        owner,
        target,
        { accessExpiresAt: null },
        chatWorkspaceChannels,
        true,
      );
      expect(changed.guest.access).toEqual({
        kind: 'guest',
        historySince: clock.now().toISOString(),
        expiresAt: null,
      });
      expect(changed.guest.joinedAt).toBe(clock.now().toISOString());
      expect(changed.revokeChannelIds).toContain(channelId);
      const member = await db
        .selectFrom('channel_members')
        .selectAll()
        .where('user_id', '=', target)
        .where('channel_id', '=', channelId)
        .executeTakeFirstOrThrow();
      expect(member.unread_count).toBe(0);
      expect(member.unread_mention_count).toBe(0);
      expect(member.last_read_message_id).toBeNull();
      expect(member.state_version).toBe(43);
      expect(new Date(member.joined_at).toISOString()).toBe(clock.now().toISOString());
      const scope = await db
        .selectFrom('channel_read_scopes')
        .selectAll()
        .where('user_id', '=', target)
        .where('channel_id', '=', channelId)
        .executeTakeFirstOrThrow();
      expect(new Date(scope.unread_since ?? 0).toISOString()).toBe(clock.now().toISOString());
      expect(scope.unread_history_from).toBeNull();
      expect(scope.thread_read_baseline_id).toBeNull();
      const guest = await requireChannelById(db, target, channelId);
      expect((await messageHistory(db, guest, {})).data).toEqual([]);
      const newAt = new Date(clock.now().getTime() + 1);
      const newId = messageId(newAt);
      await sendMessage(db, fixedClock(newAt), author, {
        id: newId,
        content: 'After renewed access',
      });
      expect((await messageHistory(db, guest, {})).data.map((row) => row.id)).toEqual([newId]);
      expect(
        (await requireWorkspaceMembership(db, target, owner.workspaceId)).guest?.historySince,
      ).toBeDefined();
    });
  });

  test('changing expiry invalidates retained live policies without moving an active history floor', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId, privateId } = await setup(db);
      const target = guestIds[0] ?? '';
      const before = (await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).data.find(
        (row) => row.user.id === target,
      );
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const changed = await updateGuestAccess(
        db,
        fixedClock(new Date()),
        owner,
        target,
        { accessExpiresAt: expiresAt },
        chatWorkspaceChannels,
        true,
      );
      expect(changed.guest.access.historySince).toBe(before?.access.historySince ?? 'missing');
      expect(changed.guest.access.expiresAt).toBe(expiresAt);
      expect([...changed.revokeChannelIds].sort()).toEqual([channelId, privateId].sort());
    });
  });

  test('refuses inaccessible scope, invalid expiry, broad privilege fields and ordinary targets without writing', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId, privateId } = await setup(db);
      const target = guestIds[0] ?? '';
      const clock = fixedClock(new Date());
      const cases = [
        { request: { channelIds: [privateId] }, code: 'CHANNEL_NOT_FOUND' },
        {
          request: { accessExpiresAt: new Date(clock.now().getTime() - 1).toISOString() },
          code: 'VALIDATION_FAILED',
        },
        { request: { accessExpiresAt: clock.now().toISOString() }, code: 'VALIDATION_FAILED' },
        { request: { role: 'owner' }, code: 'VALIDATION_FAILED' },
        { request: {}, code: 'VALIDATION_FAILED' },
      ];
      for (const entry of cases)
        expect(
          await attempt(db, () =>
            updateGuestAccess(db, clock, owner, target, entry.request, chatWorkspaceChannels, true),
          ),
        ).toBe(entry.code);
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            memberId,
            { accessExpiresAt: null },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
      const elsewhere = await setup(db);
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            elsewhere.guestIds[0] ?? '',
            { accessExpiresAt: null },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            'invalid-target',
            { accessExpiresAt: null },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
      const actual = chatWorkspaceChannels.guests;
      if (actual === undefined) throw new Error('Missing guest conversation adapter');
      const delegated: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...actual,
          prepareEdit: () =>
            Promise.resolve({
              apply: () =>
                Promise.resolve({
                  visibleIds: [],
                  hiddenCount: 0,
                  previousIds: [],
                  removedIds: [],
                  addedCount: 0,
                  changed: false,
                }),
            }),
        },
      };
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            elsewhere.guestIds[0] ?? '',
            { accessExpiresAt: null },
            delegated,
            true,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
      const guestPortMissing = noWorkspaceChannels;
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            target,
            { accessExpiresAt: null },
            guestPortMissing,
            true,
          ),
        ),
      ).toBe('ROUTE_NOT_FOUND');
      await db
        .updateTable('users')
        .set({ deleted_at: new Date() })
        .where('id', '=', target)
        .execute();
      expect(
        await attempt(db, () =>
          updateGuestAccess(
            db,
            clock,
            owner,
            target,
            { accessExpiresAt: null },
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
      expect(
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('workspace_id', '=', owner.workspaceId)
          .where('action', '=', 'member.guest_access_changed')
          .execute(),
      ).toEqual([]);
    });
  });

  test('a bounded page plus one keeps its scope query bounded and its cursor complete', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const users = await db
        .insertInto('users')
        .values(
          Array.from({ length: 101 }, (_, index) => ({
            username: `volume-${String(index)}-${crypto.randomUUID().slice(0, 8)}`,
            email: `${crypto.randomUUID()}@example.test`,
            display_name: `Guest ${String(index)}`,
          })),
        )
        .returning('id')
        .execute();
      const at = new Date(Date.now() - 60_000);
      await db
        .insertInto('workspace_members')
        .values(
          users.map((user) => ({
            workspace_id: room.workspaceId,
            user_id: user.id,
            role: 'member' as const,
            access_kind: 'guest',
            guest_since: at,
            guest_modules: ['chat'],
            joined_at: at,
          })),
        )
        .execute();
      await db
        .insertInto('channel_members')
        .values(
          users.map((user) => ({
            channel_id: room.channelId,
            user_id: user.id,
            joined_at: at,
          })),
        )
        .execute();
      const selected: number[] = [];
      const measured = db.withPlugin({
        transformQuery: ({ node }) => node,
        transformResult: ({ result }) => {
          if (result.rows.some((row) => 'username' in row && 'guest_since' in row))
            selected.push(result.rows.length);
          return Promise.resolve(result);
        },
      });
      expect(
        (await listWorkspaceGuests(measured, owner, { limit: 1 }, chatWorkspaceChannels)).data,
      ).toHaveLength(1);
      expect(selected).toEqual([2]);
      const first = await listWorkspaceGuests(db, owner, { limit: 100 }, chatWorkspaceChannels);
      expect(first.data).toHaveLength(100);
      expect(
        first.data.every(
          (row) =>
            row.channelIds.length === 1 &&
            row.channelIds[0] === room.channelId &&
            row.hiddenChannelCount === 0,
        ),
      ).toBe(true);
      const last = await listWorkspaceGuests(
        db,
        owner,
        { limit: 100, before: first.nextCursor ?? '' },
        chatWorkspaceChannels,
      );
      expect(last.data).toHaveLength(1);
      expect(last.nextCursor).toBeNull();
      expect(new Set([...first.data, ...last.data].map((row) => row.user.id)).size).toBe(101);
    });
  });

  test('an empty list is empty, and a stale administrator is refused even when a module delegates no extra guard', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'second']);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      expect(await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).toEqual({
        data: [],
        nextCursor: null,
      });
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', room.members['second']?.userId ?? '')
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', owner.userId)
        .execute();
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest scope port');
      const delegated: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: { ...real, scopes: () => Promise.resolve(new Map<string, never>()) },
      };
      expect(await attempt(db, () => listWorkspaceGuests(db, owner, {}, delegated))).toBe(
        'FORBIDDEN',
      );
    });
  });

  test('a stopped scope module is refused by core even for an empty delegated page', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest scope port');
      const delegated: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: { ...real, scopes: () => Promise.resolve(new Map<string, never>()) },
      };
      await withinRequest(
        {
          requestId: 'guest-management-stopped',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(['chat']),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          expect(await attempt(db, () => listWorkspaceGuests(db, owner, {}, delegated))).toBe(
            'ROUTE_NOT_FOUND',
          );
        },
      );
    });
  });

  test('only an administrator already in a private channel sees its ID; archive turns live scope into an unavailable count', async () => {
    await withRollback(async (db) => {
      const { owner, privateAdminId, privateId, guestIds, channelId, memberId } = await setup(db);
      const privateAdmin = await requireWorkspaceMembership(db, privateAdminId, owner.workspaceId);
      const visible = await listWorkspaceGuests(db, privateAdmin, {}, chatWorkspaceChannels);
      expect(visible.data.find((row) => row.user.id === guestIds[0])).toMatchObject({
        hiddenChannelCount: 0,
      });
      expect(visible.data.find((row) => row.user.id === guestIds[0])?.channelIds.sort()).toEqual(
        [channelId, privateId].sort(),
      );
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest scope port');
      expect((await port.scopes(db, owner, [memberId])).size).toBe(0);
      const member = await requireWorkspaceMembership(db, memberId, owner.workspaceId);
      expect(await attempt(db, () => port.scopes(db, member, []))).toBe('FORBIDDEN');
      await db
        .updateTable('channels')
        .set({ deleted_at: new Date() })
        .where('id', '=', channelId)
        .execute();
      const archived = await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels);
      expect(archived.data.find((row) => row.user.id === guestIds[0])).toMatchObject({
        channelIds: [],
        hiddenChannelCount: 2,
      });
      expect(JSON.stringify(archived)).not.toContain(channelId);
      expect(JSON.stringify(archived)).not.toContain(privateId);
      await db
        .updateTable('users')
        .set({ deleted_at: new Date() })
        .where('id', '=', guestIds[0] ?? '')
        .execute();
      expect(
        (await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).data.map(
          (row) => row.user.id,
        ),
      ).not.toContain(guestIds[0] ?? '');
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(db, owner, { before: guestIds[0] ?? '' }, chatWorkspaceChannels),
        ),
      ).toBe('USER_NOT_FOUND');
    });
  });

  test('lists expired guests while hiding channel identities outside the administrator scope', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, channelId, privateId } = await setup(db);
      const page = await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels);
      expect(Value.Check(WorkspaceGuestPage, page)).toBe(true);
      expect(page.data).toHaveLength(3);
      const first = page.data.find((row) => row.user.id === guestIds[0]);
      expect(first).toMatchObject({ channelIds: [channelId], hiddenChannelCount: 1 });
      expect(JSON.stringify(page)).not.toContain(privateId);
      expect(JSON.stringify(page)).not.toContain('confidential-scope');
      expect(page.data.find((row) => row.user.id === guestIds[2])?.access.expiresAt).not.toBeNull();
      expect(page.nextCursor).toBeNull();
    });
  });

  test('pages equal join timestamps without duplication and refuses a foreign or ordinary-member cursor', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds, memberId } = await setup(db);
      const first = await listWorkspaceGuests(db, owner, { limit: 2 }, chatWorkspaceChannels);
      expect(first.data).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await listWorkspaceGuests(
        db,
        owner,
        { limit: 2, before: first.nextCursor ?? '' },
        chatWorkspaceChannels,
      );
      expect(second.data).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.data, ...second.data].map((row) => row.user.id)).toEqual(
        [...guestIds].sort().reverse(),
      );
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(db, owner, { before: memberId }, chatWorkspaceChannels),
        ),
      ).toBe('USER_NOT_FOUND');
      const elsewhere = await setup(db);
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest scope port');
      expect((await port.scopes(db, owner, elsewhere.guestIds)).size).toBe(0);
      expect(
        (await listWorkspaceGuests(db, owner, {}, chatWorkspaceChannels)).data
          .map((row) => row.user.id)
          .sort(),
      ).toEqual([...guestIds].sort());
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(
            db,
            owner,
            { before: elsewhere.guestIds[0] ?? '' },
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('USER_NOT_FOUND');
    });
  });

  test('pages different admission times before using the identity tie breaker', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds } = await setup(db);
      const ordered = [...guestIds].sort();
      const at = Date.now() - 120_000;
      for (const [index, userId] of ordered.entries()) {
        await db
          .updateTable('workspace_members')
          .set({ joined_at: new Date(at - index * 1_000) })
          .where('workspace_id', '=', owner.workspaceId)
          .where('user_id', '=', userId)
          .execute();
      }
      const found: string[] = [];
      let before: string | undefined;
      for (const expectedId of ordered) {
        const page = await listWorkspaceGuests(
          db,
          owner,
          { limit: 1, ...(before === undefined ? {} : { before }) },
          chatWorkspaceChannels,
        );
        expect(page.data).toHaveLength(1);
        expect(page.data[0]?.user.id).toBe(expectedId);
        found.push(page.data[0]?.user.id ?? '');
        before = page.nextCursor ?? undefined;
      }
      expect(found).toEqual(ordered);
      expect(before).toBeUndefined();
    });
  });

  test('searches literal display-name text without treating wildcard characters as an entire directory', async () => {
    await withRollback(async (db) => {
      const { owner, guestIds } = await setup(db);
      const named = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', guestIds[2] ?? '')
        .executeTakeFirstOrThrow();
      expect(
        (
          await listWorkspaceGuests(db, owner, { q: named.username }, chatWorkspaceChannels)
        ).data.map((row) => row.user.id),
      ).toEqual([guestIds[2] ?? '']);
      expect(
        (await listWorkspaceGuests(db, owner, { q: 'Görkem' }, chatWorkspaceChannels)).data.map(
          (row) => row.user.id,
        ),
      ).toEqual([guestIds[0] ?? '']);
      expect(
        (await listWorkspaceGuests(db, owner, { q: '%_' }, chatWorkspaceChannels)).data.map(
          (row) => row.user.id,
        ),
      ).toEqual([guestIds[1] ?? '']);
      expect(
        (await listWorkspaceGuests(db, owner, { q: 'no such partner' }, chatWorkspaceChannels))
          .data,
      ).toEqual([]);
    });
  });

  test('rejects ordinary actors and invalid page filters before exposing scope support', async () => {
    await withRollback(async (db) => {
      const { owner, memberId, guestIds } = await setup(db);
      const member = await requireWorkspaceMembership(db, memberId, owner.workspaceId);
      const guest = await requireWorkspaceMembership(db, guestIds[0] ?? '', owner.workspaceId);
      for (const actor of [member, guest]) {
        expect(
          await attempt(db, () => listWorkspaceGuests(db, actor, {}, chatWorkspaceChannels)),
        ).toBe('FORBIDDEN');
        expect(await attempt(db, () => listWorkspaceGuests(db, actor, {}))).toBe('FORBIDDEN');
      }
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(db, owner, { limit: 0 }, chatWorkspaceChannels),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(db, owner, { limit: 101 }, chatWorkspaceChannels),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await attempt(db, () =>
          listWorkspaceGuests(db, owner, { before: 'invalid-id' }, chatWorkspaceChannels),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await attempt(db, () => listWorkspaceGuests(db, owner, {}))).toBe('ROUTE_NOT_FOUND');
    });
  });
});
