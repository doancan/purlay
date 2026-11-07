/**
 * The notification sink on a real database (D-286): what it writes, for whom, and what it leaves unwritten. A module's notice
 * is written in the caller's transaction, so it is as atomic with the caller's work as the work is with itself.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  closeIntegrationDatabase,
  sql,
  type InboxEntries,
  type Selectable,
  type Transaction,
  withRollback,
} from '@purlay/db';
import { ServerFrame, type Topic } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { renderMetrics, serverMetrics } from '../../platform/metrics';
import { readExposition, sampleOf } from '../../testing/exposition';
import type { ModuleNotice, WrittenNotice } from '../../platform/ports/notification-sink';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { notificationSink, type KindOwners } from './sink';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const KINDS: KindOwners = new Map([['thing_assigned', 'things']]);
let tick = 0;
/** Each call a little later than the last, so the ids of rows made on one clock sort in the order they were made. */
const later = (): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + (tick += 10)));

/** What the sink tells after a commit, kept: the frames it published and the series it counted. */
const told: { topic: Topic; frame: ServerFrame }[] = [];
const recordingBus: EventBus = {
  publish: (topic, frame): Promise<void> => {
    told.push({ topic, frame });
    return Promise.resolve();
  },
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const metrics = serverMetrics(
  undefined,
  ['things'],
  [],
  [{ module: 'things', kind: 'thing_assigned' }],
);

const sinkOn = (
  kinds: KindOwners = KINDS,
  bus: EventBus = recordingBus,
): ReturnType<typeof notificationSink> =>
  notificationSink({ clock: later(), kinds, bus, log: NO_LOG, written: metrics.inboxEntries });

const anIssueId = (): string => crypto.randomUUID();

const aMember = async (
  db: Transaction,
  workspaceId: string,
  name: string,
): Promise<{ userId: string; context: WorkspaceContext }> => {
  const { userId } = await aUserRow(db, name);
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
    .execute();
  return { userId, context: await requireWorkspaceMembership(db, userId, workspaceId) };
};

/** What the counter holds for a kind, read from the page the registry renders. */
const seriesOf = (kind: string): number =>
  sampleOf(readExposition(renderMetrics(metrics)), 'purlay_inbox_entries_total', {
    module: 'things',
    kind,
  }) ?? -1;

const aWorkspace = async (db: Transaction): Promise<string> =>
  (
    await db
      .insertInto('workspaces')
      .values({ name: 'Inbox', slug: aUniqueSlug('inbox') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const noticeFor = (recipientId: string, subjectId = anIssueId()): ModuleNotice => ({
  kind: 'thing_assigned',
  recipientId,
  subject: { type: 'thing', id: subjectId },
  params: { title: 'Fix the build' },
});

/** The message of what a call threw, or `undefined` when it threw nothing: asserted on, since `rejects` is not awaitable here. */
const failureOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const entriesOf = async (db: Transaction, userId: string): Promise<Selectable<InboxEntries>[]> =>
  await db
    .selectFrom('inbox_entries')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('id', 'desc')
    .execute();

describe('integration: the notification sink', () => {
  test('writes an unread entry for another member, of the module that declares the kind, naming the actor', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const subjectId = anIssueId();
      const written = await sinkOn().notify(db, bob.context, noticeFor(ada.userId, subjectId));
      const [entry, ...rest] = await entriesOf(db, ada.userId);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        workspace_id: workspaceId,
        module: 'things',
        kind: 'thing_assigned',
        actor_id: bob.userId,
        subject_type: 'thing',
        subject_id: subjectId,
        params: { title: 'Fix the build' },
        read_at: null,
      });
      expect(written).toEqual({
        entryId: entry?.id ?? '',
        workspaceId,
        recipientId: ada.userId,
        module: 'things',
        kind: 'thing_assigned',
      });
    });
  });

  test('a kind no running module declares is refused, and nothing is written (a module that is off writes nothing)', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const notice = { ...noticeFor(ada.userId), kind: 'other_thing' };
      expect(await failureOf(sinkOn().notify(db, bob.context, notice))).toMatch(/other_thing/);
      // The module that declares the kind is off in this process: its kind is not in the map.
      expect(
        await failureOf(sinkOn(new Map()).notify(db, bob.context, noticeFor(ada.userId))),
      ).toMatch(/thing_assigned/);
      expect(await entriesOf(db, ada.userId)).toEqual([]);
    });
  });

  test('a person of another workspace is told nothing, though the id is theirs', async () => {
    await withRollback(async (db) => {
      const here = await aWorkspace(db);
      const elsewhere = await aWorkspace(db);
      const bob = await aMember(db, here, 'bob');
      const stranger = await aMember(db, elsewhere, 'eve');
      expect(await sinkOn().notify(db, bob.context, noticeFor(stranger.userId))).toBeUndefined();
      expect(await entriesOf(db, stranger.userId)).toEqual([]);
    });
  });

  test('a member who has left, and an erased account, are told nothing', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const bob = await aMember(db, workspaceId, 'bob');
      const left = await aMember(db, workspaceId, 'lena');
      const erased = await aMember(db, workspaceId, 'erin');
      await db.deleteFrom('workspace_members').where('user_id', '=', left.userId).execute();
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', erased.userId)
        .execute();
      for (const person of [left, erased]) {
        expect(await sinkOn().notify(db, bob.context, noticeFor(person.userId))).toBeUndefined();
        expect(await entriesOf(db, person.userId)).toEqual([]);
      }
    });
  });

  test('a deleted workspace is not notified through an earlier context', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', workspaceId)
        .execute();
      expect(await sinkOn().notify(db, bob.context, noticeFor(ada.userId))).toBeUndefined();
      expect(await entriesOf(db, ada.userId)).toEqual([]);
    });
  });

  test('the one acting is not told of what they did themselves', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const bob = await aMember(db, workspaceId, 'bob');
      expect(await sinkOn().notify(db, bob.context, noticeFor(bob.userId))).toBeUndefined();
      expect(await entriesOf(db, bob.userId)).toEqual([]);
    });
  });

  test('telling again of one subject while the first is unread raises that entry, and a read one is not raised', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const carol = await aMember(db, workspaceId, 'carol');
      const subjectId = anIssueId();
      const other = anIssueId();
      const first = await sinkOn().notify(db, bob.context, noticeFor(ada.userId, subjectId));
      await sinkOn().notify(db, bob.context, noticeFor(ada.userId, other));
      const again = await sinkOn().notify(db, carol.context, {
        ...noticeFor(ada.userId, subjectId),
        params: { title: 'Fix the build, again' },
      });
      const entries = await entriesOf(db, ada.userId);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        id: again?.entryId,
        subject_id: subjectId,
        actor_id: carol.userId,
        params: { title: 'Fix the build, again' },
      });
      expect(entries[0]?.id).not.toBe(first?.entryId);
      await db
        .updateTable('inbox_entries')
        .set({ read_at: NOW })
        .where('subject_id', '=', subjectId)
        .execute();
      await sinkOn().notify(db, bob.context, noticeFor(ada.userId, subjectId));
      expect(
        (await entriesOf(db, ada.userId)).filter((entry) => entry.subject_id === subjectId),
      ).toHaveLength(2);
    });
  });

  test('is atomic with the caller’s transaction: what a rollback undoes leaves no entry', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      await sql`savepoint before_the_notice`.execute(db);
      await sinkOn().notify(db, bob.context, noticeFor(ada.userId));
      expect(await entriesOf(db, ada.userId)).toHaveLength(1);
      await sql`rollback to savepoint before_the_notice`.execute(db);
      expect(await entriesOf(db, ada.userId)).toEqual([]);
    });
  });

  test('refuses what is not a short, plain notice, and writes nothing', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const refused: ModuleNotice[] = [
        { ...noticeFor(ada.userId), recipientId: 'not-an-id' },
        { ...noticeFor(ada.userId), subject: { type: 'thing', id: 'not-an-id' } },
        { ...noticeFor(ada.userId), subject: { type: '', id: anIssueId() } },
        { ...noticeFor(ada.userId), subject: { type: 'x'.repeat(33), id: anIssueId() } },
        { ...noticeFor(ada.userId), params: { title: 'x'.repeat(201) } },
        { ...noticeFor(ada.userId), params: { '': 'a key with no name' } },
        { ...noticeFor(ada.userId), params: { ['k'.repeat(25)]: 'a key too long' } },
        {
          ...noticeFor(ada.userId),
          params: Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`k${String(at)}`, at])),
        },
        {
          ...noticeFor(ada.userId),
          params: Object.fromEntries(
            Array.from({ length: 8 }, (_, at) => [`k${String(at)}`, 'é'.repeat(100)]),
          ),
        },
      ];
      for (const notice of refused) {
        expect(await failureOf(sinkOn().notify(db, bob.context, notice))).toBeDefined();
      }
      expect(await entriesOf(db, ada.userId)).toEqual([]);
    });
  });

  test('keeps Unicode and markup-shaped words as plain data', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const title = "İstanbul'da <b>çalış</b>'; drop table inbox_entries; -- 日本語 🚀";
      await sinkOn().notify(db, bob.context, {
        ...noticeFor(ada.userId),
        params: { title },
      });
      expect((await entriesOf(db, ada.userId))[0]?.params).toEqual({ title });
    });
  });

  describe('announce', () => {
    const written = (workspaceId: string, recipientId: string): WrittenNotice => ({
      entryId: crypto.randomUUID(),
      workspaceId,
      recipientId,
      module: 'things',
      kind: 'thing_assigned',
    });

    test('tells each person once per workspace, on their own topic and no other, and counts every notice', async () => {
      const workspaceId = crypto.randomUUID();
      const [ada, bob] = [crypto.randomUUID(), crypto.randomUUID()];
      told.splice(0);
      const before = seriesOf('thing_assigned');
      await sinkOn().announce([
        written(workspaceId, ada),
        written(workspaceId, ada),
        written(workspaceId, bob),
      ]);
      expect(told.map(({ topic }) => topic).sort()).toEqual(
        [userTopic(ada), userTopic(bob)].sort(),
      );
      for (const { frame } of told) {
        expect(frame).toMatchObject({ event: 'INBOX_UPDATED', data: { workspaceId } });
        expect(Value.Check(ServerFrame, frame)).toBe(true);
      }
      expect(seriesOf('thing_assigned') - before).toBe(3);
    });

    test('tells nothing of nothing', async () => {
      told.splice(0);
      await sinkOn().announce([]);
      expect(told).toEqual([]);
    });

    test('a bus that fails is logged and is not the caller’s error, and the other people are still told', async () => {
      const heard: string[] = [];
      const flaky: EventBus = {
        ...recordingBus,
        publish: (topic): Promise<void> => {
          if (topic === userTopic('down')) return Promise.reject(new Error('the bus is down'));
          heard.push(topic);
          return Promise.resolve();
        },
      };
      const workspaceId = crypto.randomUUID();
      await sinkOn(KINDS, flaky).announce([
        written(workspaceId, 'down'),
        written(workspaceId, 'up'),
      ]);
      expect(heard).toEqual([userTopic('up')]);
    });
  });
});
