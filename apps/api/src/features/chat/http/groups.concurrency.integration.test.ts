/** Real connections serialize the cap and placement/star; failed writes roll back the whole move. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { CHANNEL_GROUP_LIMIT } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { testDependencies } from '../../../testing/doubles';
import { createApp } from '../../../ingress/http/app';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { channelFor } from '../channels/channels';
import { listGroups, moveToGroup, removeGroup, saveGroup } from '../channels/groups';
import { setStarred } from '../channels/star';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const clock = fixedClock(new Date('2026-11-07T12:00:00.000Z'));

describe('integration: competing personal navigation changes', () => {
  test('different owners claiming one fresh id cannot overwrite or disclose one another’s group', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const owners = await Promise.all(
      Object.values(room.members).map(
        async (member) => await requireWorkspaceMembership(db, member.userId, room.workspaceId),
      ),
    );
    const id = crypto.randomUUID();
    // Hold both INSERTs after their existence checks: a random scheduling race would seldom
    // exercise the upsert's authority check, because the second reader usually sees the first row.
    const lock = 1198001;
    await sql`CREATE FUNCTION wait_for_group_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(1198001); RETURN NEW; END $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER wait_for_group_claim BEFORE INSERT ON channel_groups FOR EACH ROW EXECUTE FUNCTION wait_for_group_claim()`.execute(
      db,
    );
    try {
      await db.connection().execute(async (holder) => {
        await sql`select pg_advisory_lock(${lock})`.execute(holder);
        const attempts = Promise.allSettled(
          owners.map(
            async (context, index) =>
              await db
                .transaction()
                .execute(async (tx) => await saveGroup(tx, context, id, `Owner ${String(index)}`)),
          ),
        );
        try {
          const deadline = Date.now() + 2000;
          let waiting = 0;
          while (waiting < 2 && Date.now() < deadline) {
            const observed = await sql<{
              count: number;
            }>`select count(*)::int as count from pg_locks where locktype = 'advisory' and objid = ${lock} and not granted`.execute(
              holder,
            );
            waiting = observed.rows[0]?.count ?? 0;
            if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(waiting).toBe(2);
        } finally {
          await sql`select pg_advisory_unlock(${lock})`.execute(holder);
        }
        const results = await attempts;
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status !== 'rejected') throw new Error('missing refusal');
        expect(failed.reason).toMatchObject({ body: { code: 'CHANNEL_GROUP_NOT_FOUND' } });
        const lists = await Promise.all(
          owners.map(async (context) => await listGroups(db, context, {})),
        );
        expect(lists.map((list) => list.data.length).sort()).toEqual([0, 1]);
        const winner = results.findIndex((result) => result.status === 'fulfilled');
        expect(lists[winner]?.data[0]?.name).toBe(`Owner ${String(winner)}`);
      });
    } finally {
      await sql`DROP TRIGGER wait_for_group_claim ON channel_groups`.execute(db);
      await sql`DROP FUNCTION wait_for_group_claim()`.execute(db);
    }
  });

  test('two creations at the cap leave exactly the allowed number, and repeated ids are one creation', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const member = room.members['alice'];
    if (member === undefined) throw new Error('missing alice');
    const context = await requireWorkspaceMembership(db, member.userId, room.workspaceId);
    const oneId = crypto.randomUUID();
    const repeat = await Promise.all(
      [0, 1].map(
        async () =>
          await db.transaction().execute(async (tx) => await saveGroup(tx, context, oneId, 'Same')),
      ),
    );
    expect(repeat.map((result) => result.changed).sort()).toEqual([false, true]);
    for (let index = 1; index < CHANNEL_GROUP_LIMIT - 1; index += 1)
      await db
        .transaction()
        .execute(
          async (tx) => await saveGroup(tx, context, crypto.randomUUID(), `Team ${String(index)}`),
        );
    const competing = await Promise.allSettled(
      [0, 1].map(
        async (index) =>
          await db
            .transaction()
            .execute(
              async (tx) =>
                await saveGroup(tx, context, crypto.randomUUID(), `Last ${String(index)}`),
            ),
      ),
    );
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = competing.find((result) => result.status === 'rejected');
    if (refused?.status !== 'rejected') throw new Error('missing refusal');
    expect(refused.reason).toMatchObject({ body: { code: 'CHANNEL_GROUP_LIMIT' } });
    expect((await listGroups(db, context, { limit: 100 })).data).toHaveLength(CHANNEL_GROUP_LIMIT);
  });

  test('a move and a star leave one placement in either commit order', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const member = room.members['alice'];
    if (member === undefined) throw new Error('missing alice');
    const context = await requireWorkspaceMembership(db, member.userId, room.workspaceId);
    const id = crypto.randomUUID();
    await db.transaction().execute(async (tx) => await saveGroup(tx, context, id, 'Operations'));
    await Promise.all([
      db.transaction().execute(async (tx) => await moveToGroup(tx, member.context, id)),
      db.transaction().execute(async (tx) => await setStarred(tx, clock, member.context, true)),
    ]);
    const channel = await channelFor(db, member.userId, room.channelId);
    if (channel.starred) expect(channel.sidebarGroupId).toBeNull();
    else expect(channel.sidebarGroupId).toBe(id);
  });

  test('deleting a heading during a move cannot strand a placement or remove membership', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const member = room.members['alice'];
    if (member === undefined) throw new Error('missing alice');
    const context = await requireWorkspaceMembership(db, member.userId, room.workspaceId);
    const id = crypto.randomUUID();
    await db.transaction().execute(async (tx) => await saveGroup(tx, context, id, 'Finance'));
    const results = await Promise.allSettled([
      db.transaction().execute(async (tx) => await moveToGroup(tx, member.context, id)),
      db.transaction().execute(async (tx) => await removeGroup(tx, context, id)),
    ]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'rejected')
      expect(results[0].reason).toMatchObject({ body: { code: 'CHANNEL_GROUP_NOT_FOUND' } });
    const channel = await channelFor(db, member.userId, room.channelId);
    expect(channel.sidebarGroupId).toBeNull();
    expect(channel.state).not.toBeNull();
  });

  test('failure after placement insertion rolls it back and preserves the former star; retry succeeds', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const member = room.members['alice'];
    if (member === undefined) throw new Error('missing alice');
    const context = await requireWorkspaceMembership(db, member.userId, room.workspaceId);
    const id = crypto.randomUUID();
    await db.transaction().execute(async (tx) => {
      await saveGroup(tx, context, id, 'Sales');
      await setStarred(tx, clock, member.context, true);
    });
    const session = await aSession(db, clock, member.userId, 30);
    const app = createApp(testDependencies({ database: db, clock }));
    const move = async (): Promise<Response> =>
      await app.handle(
        new Request(`https://purlay.test/api/channels/${room.channelId}/sidebar-group`, {
          method: 'PUT',
          headers: {
            cookie: `${SESSION_COOKIE}=${session.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ groupId: id }),
        }),
      );
    await sql`CREATE FUNCTION refuse_group_unstar() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.starred_at IS NOT NULL AND NEW.starred_at IS NULL THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER refuse_group_unstar BEFORE UPDATE ON channel_members FOR EACH ROW EXECUTE FUNCTION refuse_group_unstar()`.execute(
      db,
    );
    try {
      expect((await move()).status).toBe(500);
      expect(await channelFor(db, member.userId, room.channelId)).toMatchObject({
        starred: true,
        sidebarGroupId: null,
      });
      expect(
        await db
          .selectFrom('channel_group_channels')
          .selectAll()
          .where('channel_id', '=', room.channelId)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER refuse_group_unstar ON channel_members`.execute(db);
      await sql`DROP FUNCTION refuse_group_unstar()`.execute(db);
    }
    expect((await move()).status).toBe(200);
    expect(await channelFor(db, member.userId, room.channelId)).toMatchObject({
      starred: false,
      sidebarGroupId: id,
    });
  });
});
