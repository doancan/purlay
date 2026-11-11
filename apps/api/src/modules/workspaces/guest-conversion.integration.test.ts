/** Explicit full access, preserved assignments/read state, fresh authority and atomic conversion. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { WorkspaceMember, messageId } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { attempt } from '../../testing/attempt';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireChannelById } from '../../features/chat/channels/guard';
import { createChannel } from '../../features/chat/channels/channels';
import { messageHistory, sendMessage } from '../../features/chat/messages/messages';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createGuestInvitation } from './guest-invitations';
import { acceptInvitation } from './invitations';
import { changeRole } from './members';
import { convertGuest } from './guest-conversion';
import { noWorkspaceChannels, type WorkspaceChannels } from './channels-port';
afterAll(async () => {
  await closeIntegrationDatabase();
});
const setup = async (
  db: Transaction,
): Promise<{
  owner: Awaited<ReturnType<typeof requireWorkspaceMembership>>;
  guest: string;
  member: string;
  publicId: string;
  privateId: string;
  oldId: string;
}> => {
  const room = await aRoom(db, ['owner', 'member']);
  const owner = await requireWorkspaceMembership(
    db,
    room.members['owner']?.userId ?? '',
    room.workspaceId,
  );
  const privateChannel = await createChannel(db, fixedClock(new Date()), owner, {
    name: 'hidden-contract',
    type: 'private',
  });
  const oldAt = new Date(Date.now() - 60000);
  const oldId = messageId(oldAt);
  await sendMessage(
    db,
    fixedClock(oldAt),
    await requireChannelById(db, owner.userId, room.channelId),
    { id: oldId, content: 'Before guest admission' },
  );
  const user = await aUserRow(db, 'convert-guest');
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', user.userId)
    .execute();
  const clock = fixedClock(new Date(Date.now() - 30000));
  const invitation = await createGuestInvitation(
    db,
    clock,
    owner,
    { email: user.email, channelIds: [room.channelId, privateChannel.id], accessExpiresAt: null },
    chatWorkspaceChannels,
  );
  await acceptInvitation(
    db,
    clock,
    user.userId,
    invitation.token,
    undefined,
    chatWorkspaceChannels,
    true,
  );
  return {
    owner,
    guest: user.userId,
    member: room.members['member']?.userId ?? '',
    publicId: room.channelId,
    privateId: privateChannel.id,
    oldId,
  };
};
const confirm = { confirmFullAccess: true };
describe('integration: explicit guest conversion', () => {
  test('only deliberate full conversion unlocks earlier history, preserves private assignments and read state, and retries retain a later role', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      const clock = fixedClock(new Date());
      expect(
        (await messageHistory(db, await requireChannelById(db, f.guest, f.publicId), {})).data.map(
          (m) => m.id,
        ),
      ).not.toContain(f.oldId);
      expect(await attempt(db, () => changeRole(db, clock, f.owner, f.guest, 'admin'))).toBe(
        'FORBIDDEN',
      );
      const state = await db
        .selectFrom('channel_members')
        .selectAll()
        .where('user_id', '=', f.guest)
        .orderBy('channel_id')
        .execute();
      const result = await convertGuest(
        db,
        clock,
        f.owner,
        f.guest,
        confirm,
        chatWorkspaceChannels,
      );
      expect(Value.Check(WorkspaceMember, result.member)).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.member.role).toBe('member');
      expect(result.member.accessKind).toBeUndefined();
      expect(
        (await messageHistory(db, await requireChannelById(db, f.guest, f.publicId), {})).data.map(
          (m) => m.id,
        ),
      ).toContain(f.oldId);
      expect((await requireChannelById(db, f.guest, f.privateId)).channelId).toBe(f.privateId);
      expect(
        await db
          .selectFrom('channel_members')
          .selectAll()
          .where('user_id', '=', f.guest)
          .orderBy('channel_id')
          .execute(),
      ).toEqual(state);
      expect(
        await db
          .selectFrom('workspace_members')
          .select(['access_kind', 'guest_since', 'guest_expires_at', 'guest_modules', 'joined_at'])
          .where('workspace_id', '=', f.owner.workspaceId)
          .where('user_id', '=', f.guest)
          .executeTakeFirst(),
      ).toEqual({
        access_kind: 'member',
        guest_since: null,
        guest_expires_at: null,
        guest_modules: null,
        joined_at: new Date(result.member.joinedAt),
      });
      await changeRole(db, clock, f.owner, f.guest, 'admin');
      const again = await convertGuest(db, clock, f.owner, f.guest, confirm, chatWorkspaceChannels);
      expect(again.changed).toBe(false);
      expect(again.member.role).toBe('admin');
      expect(again.notifyUserIds).toEqual([]);
      const audit = await db
        .selectFrom('audit_log')
        .select('metadata')
        .where('workspace_id', '=', f.owner.workspaceId)
        .where('action', '=', 'member.guest_converted')
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(f.privateId);
    });
  });
  test('refuses malformed acknowledgments, lower roles, foreign/deleted targets and an unavailable module', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      const clock = fixedClock(new Date());
      for (const input of [
        {},
        null,
        { confirmFullAccess: false },
        { confirmFullAccess: true, role: 'owner' },
      ])
        expect(
          await attempt(db, () =>
            convertGuest(db, clock, f.owner, f.guest, input, chatWorkspaceChannels),
          ),
        ).toBe('VALIDATION_FAILED');
      for (const actor of [f.member, f.guest])
        expect(
          await attempt(
            db,
            async () =>
              await convertGuest(
                db,
                clock,
                await requireWorkspaceMembership(db, actor, f.owner.workspaceId),
                f.guest,
                confirm,
                chatWorkspaceChannels,
              ),
          ),
        ).toBe('FORBIDDEN');
      for (const target of [
        'bad-id',
        crypto.randomUUID(),
        (await aUserRow(db, 'outside-conversion')).userId,
      ])
        expect(
          await attempt(db, () =>
            convertGuest(db, clock, f.owner, target, confirm, chatWorkspaceChannels),
          ),
        ).toBe('USER_NOT_FOUND');
      expect(
        await attempt(db, () =>
          convertGuest(db, clock, f.owner, f.guest, confirm, noWorkspaceChannels),
        ),
      ).toBe('ROUTE_NOT_FOUND');
      await db
        .updateTable('users')
        .set({ deleted_at: clock.now() })
        .where('id', '=', f.guest)
        .execute();
      expect(
        await attempt(db, () =>
          convertGuest(db, clock, f.owner, f.guest, confirm, chatWorkspaceChannels),
        ),
      ).toBe('USER_NOT_FOUND');
    });
  });
  test('an expired guest needs explicit conversion and becomes a full member without changing join history', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      const clock = fixedClock(new Date());
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(Date.now() - 1000) })
        .where('workspace_id', '=', f.owner.workspaceId)
        .where('user_id', '=', f.guest)
        .execute();
      expect(
        await attempt(db, () => requireWorkspaceMembership(db, f.guest, f.owner.workspaceId)),
      ).toBe('WORKSPACE_NOT_FOUND');
      const before = await db
        .selectFrom('workspace_members')
        .select('joined_at')
        .where('workspace_id', '=', f.owner.workspaceId)
        .where('user_id', '=', f.guest)
        .executeTakeFirstOrThrow();
      const result = await convertGuest(
        db,
        clock,
        f.owner,
        f.guest,
        confirm,
        chatWorkspaceChannels,
      );
      expect(result.member.joinedAt).toBe(before.joined_at.toISOString());
      expect(
        (await requireWorkspaceMembership(db, f.guest, f.owner.workspaceId)).guest,
      ).toBeUndefined();
    });
  });
  test('rechecks a manager demoted during preparation instead of trusting the minted context', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw Error('Missing guest port');
      const port: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...real,
          prepareEdit: async (...args) => {
            const prepared = await real.prepareEdit(...args);
            await db
              .updateTable('workspace_members')
              .set({ role: 'member' })
              .where('workspace_id', '=', f.owner.workspaceId)
              .where('user_id', '=', f.owner.userId)
              .execute();
            return prepared;
          },
        },
      };
      expect(
        await attempt(db, () =>
          convertGuest(db, fixedClock(new Date()), f.owner, f.guest, confirm, port),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('a demoted caller cannot use an idempotent full-target retry to bypass the fresh manager check', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      let changed = false;
      const executor = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: async (args) => {
          if (
            !changed &&
            args.result.rows.some(
              (row) => row['access_kind'] === 'member' && Object.keys(row).length === 1,
            )
          ) {
            changed = true;
            await db
              .updateTable('workspace_members')
              .set({ role: 'member' })
              .where('workspace_id', '=', f.owner.workspaceId)
              .where('user_id', '=', f.owner.userId)
              .execute();
          }
          return args.result;
        },
      });
      expect(
        await attempt(db, () =>
          convertGuest(
            executor,
            fixedClock(new Date()),
            f.owner,
            f.member,
            confirm,
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('FORBIDDEN');
      expect(changed).toBe(true);
    });
  });

  test('a target removed during scope preparation is not confused with their full membership elsewhere', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      const other = await aRoom(db, ['owner']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: other.workspaceId, user_id: f.guest, role: 'owner' })
        .execute();
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest port');
      const port: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...real,
          prepareEdit: async (...args) => {
            const held = await real.prepareEdit(...args);
            await db
              .deleteFrom('workspace_members')
              .where('workspace_id', '=', f.owner.workspaceId)
              .where('user_id', '=', f.guest)
              .execute();
            return held;
          },
        },
      };
      expect(
        await attempt(db, () =>
          convertGuest(db, fixedClock(new Date()), f.owner, f.guest, confirm, port),
        ),
      ).toBe('USER_NOT_FOUND');
    });
  });
  test('an audit database failure rolls authority back with its record', async () => {
    await withRollback(async (db) => {
      const f = await setup(db);
      await sql`CREATE FUNCTION pg_temp.reject_conversion() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'conversion-audit'; END; $$`.execute(
        db,
      );
      await sql`CREATE TRIGGER reject_conversion BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'member.guest_converted') EXECUTE FUNCTION pg_temp.reject_conversion()`.execute(
        db,
      );
      expect(
        await attempt(db, () =>
          convertGuest(
            db,
            fixedClock(new Date()),
            f.owner,
            f.guest,
            confirm,
            chatWorkspaceChannels,
          ),
        ),
      ).toContain('conversion-audit');
      expect(
        (await requireWorkspaceMembership(db, f.guest, f.owner.workspaceId)).guest,
      ).toBeDefined();
      expect(
        (await messageHistory(db, await requireChannelById(db, f.guest, f.publicId), {})).data.map(
          (m) => m.id,
        ),
      ).not.toContain(f.oldId);
    });
  });
});
