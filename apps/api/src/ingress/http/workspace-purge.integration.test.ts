/**
 * `purge:workspaces` against the real database (D-242): nothing before the grace period is over, to the
 * millisecond; after it, everything that names the workspace gone — its files from the store too — and the
 * same of another workspace, the control, untouched; one line on the server's trail, and the row left as a
 * tombstone; more than a batch over as many transactions as it takes; a run cut off half way finished by the
 * next, and a run after that doing nothing; a file the store refuses left for `sweep:deletions`, and said.
 * And the catalogue: every table that refers to a workspace is one the erasure empties or the trail keeps.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS, messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { workspacePrefix } from '../../platform/storage';
import { createApp } from './app';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { aUniqueSlug } from '../../testing/users';
import { sweepObjectDeletions } from '../../modules/attachments/deletions';
import { atomicallyOn } from '../../platform/transactions';
import {
  REMAINING_TABLES,
  WORKSPACE_PURGE_BATCH,
  purgeWorkspaceContent,
  purgeWorkspaces,
} from '../../modules/workspaces/deletion-purge';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ASKED = new Date('2026-10-20T09:00:00.000Z');
const DUE = new Date(ASKED.getTime() + WORKSPACE_DELETION_GRACE_DAYS * DAY_MS);

let tick = 0;
const anId = (): string => messageId(new Date(ASKED.getTime() + (tick += 1)));

/** Every table the catalogue says refers to `workspaces`, by a column of its own. */
const referring = async (db: Executor): Promise<string[]> =>
  (
    await sql<{ table: string }>`
      select distinct conrelid::regclass::text as table
      from pg_constraint
      where contype = 'f' and confrelid = 'workspaces'::regclass
    `.execute(db)
  ).rows
    .map((row) => row.table)
    .sort();

/** How many rows of each table name this workspace, the trails left out. */
const footprint = async (db: Executor, workspaceId: string): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const table of await referring(db)) {
    if (table === 'audit_log' || table === 'server_audit_log') continue;
    const { rows } = await sql<{ count: string }>`
      select count(*)::text as count from ${sql.table(table)} where workspace_id = ${workspaceId}
    `.execute(db);
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
};

interface Seeded {
  readonly workspaceId: string;
  readonly owner: SignedInUser;
  readonly member: SignedInUser;
  readonly name: string;
}

/**
 * A workspace as its people would leave it: channels public and private and a conversation, a thread with
 * a mention and a reaction, a pin, a save, a bookmark, a thread followed, a saved search, an invitation, a
 * GitHub token, an incident, a file sent and one not, and an export ready to download — each made through
 * the API, as the people would have.
 */
const aLivedInWorkspace = async (
  db: Executor,
  store: MemoryStore,
  label: string,
): Promise<Seeded> => {
  const clock = fixedClock(ASKED);
  const app = createApp(testDependencies({ database: db, clock, storage: store }));
  const owner = await aSignedInUser(db, clock, `${label}-owner`);
  const member = await aSignedInUser(db, clock, `${label}-member`);
  const call = async (
    method: string,
    path: string,
    as: SignedInUser,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: as.cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
    return text === '' ? null : (JSON.parse(text) as unknown);
  };
  const upload = async (): Promise<string> => {
    const id = anId();
    const response = await app.handle(
      new Request(`https://purlay.test/api/workspaces/${workspaceId}/uploads?id=${id}&name=a.txt`, {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          'content-type': 'application/octet-stream',
          'content-length': '3',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    if (response.status !== 201) throw new Error(`upload answered ${String(response.status)}`);
    return id;
  };
  const name = `Ekip ${label}`;
  const { id: workspaceId } = (await call('POST', '/api/workspaces', owner, {
    name,
    slug: aUniqueSlug(label),
  })) as { id: string };
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member', joined_at: ASKED })
    .execute();
  const { id: channelId } = (await call('POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: 'ops',
  })) as { id: string };
  await call('POST', `/api/channels/${channelId}/join`, member);
  await call('POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: 'secret',
    type: 'private',
  });
  await call('POST', `/api/workspaces/${workspaceId}/dms`, owner, { userId: member.userId });
  const root = anId();
  await call('POST', `/api/channels/${channelId}/messages`, owner, {
    id: root,
    content: `a question for @${member.username}`,
    attachmentIds: [await upload()],
  });
  await call('POST', `/api/channels/${channelId}/messages`, member, {
    id: anId(),
    content: 'an answer',
    parentId: root,
  });
  await upload();
  await call('PUT', `/api/messages/${root}/reactions/${encodeURIComponent('👍')}`, member);
  await call('PUT', `/api/messages/${root}/pin`, owner);
  await call('PUT', `/api/messages/${root}/saved`, member, {});
  await call('PUT', `/api/messages/${root}/follow`, owner, { following: true });
  await call('POST', `/api/channels/${channelId}/bookmarks`, owner, {
    url: 'https://example.test/runbook',
    title: 'Runbook',
  });
  await call('PUT', `/api/workspaces/${workspaceId}/saved-searches/${anId()}`, owner, {
    name: 'mine',
    query: { q: 'question' },
  });
  await call('POST', `/api/workspaces/${workspaceId}/invitations`, owner);
  await call('PUT', `/api/workspaces/${workspaceId}/integrations/github`, owner, {
    token: 'ghp_deletion',
  });
  await call('POST', `/api/channels/${channelId}/incident`, owner, { id: anId(), severity: 2 });
  // An export ready to download, its archive in the store.
  const exportId = anId();
  const archive = `${workspacePrefix(workspaceId)}exports/${exportId}.tar`;
  await store.put(archive, new Uint8Array(4), 'application/x-tar');
  await db
    .insertInto('workspace_exports')
    .values({
      id: exportId,
      workspace_id: workspaceId,
      requested_by: owner.userId,
      status: 'ready',
      storage_key: archive,
      size_bytes: '4',
      created_at: ASKED,
      expires_at: DUE,
    })
    .execute();
  return { workspaceId, owner, member, name };
};

/** The owner asks, at `ASKED`, through the route. */
const askToDelete = async (db: Executor, seeded: Seeded): Promise<void> => {
  const response = await createApp(
    testDependencies({ database: db, clock: fixedClock(ASKED) }),
  ).handle(
    new Request(`https://purlay.test/api/workspaces/${seeded.workspaceId}/deletion`, {
      method: 'POST',
      headers: { cookie: seeded.owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: seeded.name }),
    }),
  );
  expect(response.status).toBe(200);
};

const runAt = (db: Executor, at: Date, store: MemoryStore): ReturnType<typeof purgeWorkspaces> =>
  purgeWorkspaces({
    database: db,
    clock: fixedClock(at),
    log: aRecordingLogger().log,
    storage: store,
  });

const workspaceRow = async (
  db: Executor,
  workspaceId: string,
): Promise<{
  name: string;
  deleted_at: Date | null;
  purge_started_at: Date | null;
  purged_at: Date | null;
}> =>
  await db
    .selectFrom('workspaces')
    .select(['name', 'deleted_at', 'purge_started_at', 'purged_at'])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();

const serverLines = async (db: Executor, workspaceId: string): Promise<unknown[]> =>
  await db
    .selectFrom('server_audit_log')
    .select(['action', 'actor_user_id', 'target_workspace_id', 'target_user_id'])
    .where('target_workspace_id', '=', workspaceId)
    .execute();

const nonZero = (counts: Record<string, number>): string[] =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([table]) => table)
    .sort();

describe('integration: the workspace purge', () => {
  test('every table that refers to a workspace is one the erasure empties, or a trail it keeps', async () => {
    await withRollback(async (db) => {
      const emptied = [
        'messages',
        'attachments',
        'workspace_exports',
        'channels',
        'workspace_members',
        ...REMAINING_TABLES,
      ];
      expect(await referring(db)).toEqual([...emptied, 'audit_log', 'server_audit_log'].sort());
    });
  });

  test('nothing before the grace period is over, to the millisecond; after it, everything, and the other workspace keeps all of its', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const doomed = await aLivedInWorkspace(db, store, 'doomed');
      const control = await aLivedInWorkspace(db, store, 'kept');
      const before = await footprint(db, doomed.workspaceId);
      const controlBefore = await footprint(db, control.workspaceId);
      // The measurement could have said otherwise: every table this test can reach holds something.
      expect(nonZero(before)).toEqual(
        [
          'attachments',
          'channel_bookmarks',
          'channels',
          'github_integrations',
          'incidents',
          'mentions',
          'messages',
          'notifications',
          'pinned_messages',
          'saved_messages',
          'saved_searches',
          'thread_follows',
          'workspace_exports',
          'workspace_invitations',
          'workspace_members',
        ].sort(),
      );
      const keysBefore = store.keys();
      expect(keysBefore.filter((key) => key.includes(doomed.workspaceId))).toHaveLength(3);
      await askToDelete(db, doomed);

      expect(await runAt(db, new Date(DUE.getTime() - 1), store)).toEqual({
        workspaces: 0,
        messages: 0,
        files: 0,
        leftBehind: 0,
      });
      expect(await footprint(db, doomed.workspaceId)).toEqual(before);
      expect((await workspaceRow(db, doomed.workspaceId)).purge_started_at).toBeNull();

      expect(await runAt(db, DUE, store)).toEqual({
        workspaces: 1,
        messages: 2,
        files: 3,
        leftBehind: 0,
      });
      expect(nonZero(await footprint(db, doomed.workspaceId))).toEqual([]);
      expect(store.keys().filter((key) => key.includes(doomed.workspaceId))).toEqual([]);
      // The other workspace: every row and every file as it was.
      expect(await footprint(db, control.workspaceId)).toEqual(controlBefore);
      expect(store.keys()).toEqual(keysBefore.filter((key) => !key.includes(doomed.workspaceId)));
      // The row stays, a tombstone with its name; the server's trail says it went, and who did nothing.
      expect(await workspaceRow(db, doomed.workspaceId)).toEqual({
        name: doomed.name,
        deleted_at: ASKED,
        purge_started_at: DUE,
        purged_at: DUE,
      });
      expect(await serverLines(db, doomed.workspaceId)).toEqual([
        {
          action: 'server.workspace_purged',
          actor_user_id: null,
          target_workspace_id: doomed.workspaceId,
          target_user_id: null,
        },
      ]);
      expect(await serverLines(db, control.workspaceId)).toEqual([]);
      // Its people keep their accounts and their sessions: they may be in other workspaces.
      for (const person of [doomed.owner, doomed.member]) {
        const sessions = await db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', person.userId)
          .execute();
        expect(sessions).toHaveLength(1);
      }
      // Run again: nothing more, and no second line.
      expect(await runAt(db, new Date(DUE.getTime() + DAY_MS), store)).toEqual({
        workspaces: 0,
        messages: 0,
        files: 0,
        leftBehind: 0,
      });
      expect(await serverLines(db, doomed.workspaceId)).toHaveLength(1);
      // And a run that had read it as claimed before the first marked it purged — two at once — finds
      // nothing to do, and writes no second line either.
      await purgeWorkspaceContent(
        { database: db, clock: fixedClock(DUE), log: aRecordingLogger().log, storage: store },
        doomed.workspaceId,
      );
      expect(await serverLines(db, doomed.workspaceId)).toHaveLength(1);
    });
  });

  test('a deletion taken back in time is never claimed', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const seeded = await aLivedInWorkspace(db, store, 'spared');
      const before = await footprint(db, seeded.workspaceId);
      await askToDelete(db, seeded);
      await db
        .updateTable('workspaces')
        .set({ deleted_at: null })
        .where('id', '=', seeded.workspaceId)
        .execute();
      expect((await runAt(db, DUE, store)).workspaces).toBe(0);
      expect(await footprint(db, seeded.workspaceId)).toEqual(before);
    });
  });

  test('more than a batch: every message goes, no transaction taking more than a batch', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const seeded = await aLivedInWorkspace(db, store, 'large');
      const { id: channelId } = await db
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', seeded.workspaceId)
        .where('name', '=', 'ops')
        .executeTakeFirstOrThrow();
      const roots = Array.from({ length: WORKSPACE_PURGE_BATCH + 1 }, () => anId());
      await db
        .insertInto('messages')
        .values(
          roots.map((id) => ({
            id,
            workspace_id: seeded.workspaceId,
            channel_id: channelId,
            sender_id: seeded.owner.userId,
            content: 'filler',
            created_at: ASKED,
          })),
        )
        .execute();
      // A reply to each, so the roots wait for their replies across batches.
      await db
        .insertInto('messages')
        .values(
          roots.map((parentId) => ({
            id: anId(),
            workspace_id: seeded.workspaceId,
            channel_id: channelId,
            sender_id: seeded.member.userId,
            parent_id: parentId,
            content: 'reply',
            created_at: ASKED,
          })),
        )
        .execute();
      await askToDelete(db, seeded);
      // Every delete from `messages` the run makes, by the rows it took.
      const deleted: number[] = [];
      const ours = new Set<unknown>();
      const watched = db.withPlugin({
        transformQuery: (args) => {
          const node = args.node;
          if (node.kind === 'DeleteQueryNode' && JSON.stringify(node.from).includes('"messages"')) {
            ours.add(args.queryId);
          }
          return node;
        },
        transformResult: (args) => {
          if (ours.has(args.queryId)) deleted.push(Number(args.result.numAffectedRows ?? 0));
          return Promise.resolve(args.result);
        },
      });
      const counted = await db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('workspace_id', '=', seeded.workspaceId)
        .executeTakeFirstOrThrow();
      expect(Number(counted.count)).toBe(2 * (WORKSPACE_PURGE_BATCH + 1) + 2);
      expect((await runAt(watched, DUE, store)).messages).toBe(2 * (WORKSPACE_PURGE_BATCH + 1) + 2);
      // Replies in two batches and a short one, then the roots the same: no statement past a batch.
      expect(deleted).toEqual([WORKSPACE_PURGE_BATCH, 2, WORKSPACE_PURGE_BATCH, 2]);
      expect(nonZero(await footprint(db, seeded.workspaceId))).toEqual([]);
    });
  });

  test('a run cut off half way is finished by the next, which writes the one line', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const seeded = await aLivedInWorkspace(db, store, 'crash');
      await askToDelete(db, seeded);
      // The process dies as it reaches the channels: messages and files gone, the rest still there.
      const dying = db.withPlugin({
        transformQuery: (args) => {
          if (
            args.node.kind === 'DeleteQueryNode' &&
            JSON.stringify(args.node.from).includes('"channels"')
          ) {
            throw new Error('the process stopped');
          }
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const crashed = await runAt(dying, DUE, store).then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(crashed)).toContain('failed in 1 workspace');
      const half = await footprint(db, seeded.workspaceId);
      expect(half['messages']).toBe(0);
      expect(half['channels']).toBeGreaterThan(0);
      expect((await workspaceRow(db, seeded.workspaceId)).purged_at).toBeNull();
      expect(await serverLines(db, seeded.workspaceId)).toEqual([]);

      expect((await runAt(db, new Date(DUE.getTime() + DAY_MS), store)).workspaces).toBe(1);
      expect(nonZero(await footprint(db, seeded.workspaceId))).toEqual([]);
      expect(await serverLines(db, seeded.workspaceId)).toHaveLength(1);
    });
  });

  test('a file the store will not delete waits for the sweep, and the run says so', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const seeded = await aLivedInWorkspace(db, store, 'refused');
      await askToDelete(db, seeded);
      store.failing('delete', new Error('the store is down'));
      const refused = await runAt(db, DUE, store).then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(refused)).toContain('could not delete');
      // The rows are gone; the files are named in the queue, not forgotten.
      expect(nonZero(await footprint(db, seeded.workspaceId))).toEqual([]);
      const waiting = await db
        .selectFrom('object_deletions')
        .select('storage_key')
        .where('storage_key', 'like', `%${seeded.workspaceId}%`)
        .execute();
      expect(waiting).toHaveLength(3);
      // The store back, the sweep lets them go.
      const working = aMemoryStore();
      for (const key of store.keys())
        await working.put(key, new Uint8Array(1), 'application/octet-stream');
      await sweepObjectDeletions({
        database: db,
        atomically: atomicallyOn(db),
        log: aRecordingLogger().log,
        storage: working,
      });
      expect(working.keys().filter((key) => key.includes(seeded.workspaceId))).toEqual([]);
    });
  });
});
