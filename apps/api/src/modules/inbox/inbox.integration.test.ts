/**
 * Reading the core's inbox on a real database (D-286): whose notices, from which modules, in what order and how many pages;
 * and what marking them read does and does not touch.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, type Transaction, withRollback } from '@purlay/db';
import { InboxPage, messageId, PAGE_LIMIT } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { inboxPage, markInboxRead } from './inbox';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const RUNNING = ['things'];

interface Person {
  readonly userId: string;
  readonly context: WorkspaceContext;
}

const aWorkspace = async (db: Transaction): Promise<string> =>
  (
    await db
      .insertInto('workspaces')
      .values({ name: 'Inbox', slug: aUniqueSlug('read') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const aMember = async (db: Transaction, workspaceId: string, name: string): Promise<Person> => {
  const { userId } = await aUserRow(db, name);
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
    .execute();
  return { userId, context: await requireWorkspaceMembership(db, userId, workspaceId) };
};

let tick = 0;
/** A notice for `who`, made a little after the one before it; the id says when, as the sink's do. */
const told = async (
  db: Transaction,
  workspaceId: string,
  who: string,
  options: { module?: string; read?: boolean; title?: string } = {},
): Promise<string> => {
  const at = new Date(NOW.getTime() + (tick += 10));
  const id = messageId(at);
  await db
    .insertInto('inbox_entries')
    .values({
      id,
      workspace_id: workspaceId,
      user_id: who,
      module: options.module ?? 'things',
      kind: 'thing_assigned',
      subject_type: 'thing',
      subject_id: crypto.randomUUID(),
      params: JSON.stringify({ title: options.title ?? 'A thing' }),
      read_at: options.read === true ? at : null,
      created_at: at,
    })
    .execute();
  return id;
};

const clock = fixedClock(NOW);

describe('integration: the inbox’s list', () => {
  test('is the caller’s own, newest first, in the contract’s shape, with the unread count of the whole', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const first = await told(db, workspaceId, ada.userId, { title: 'first' });
      const second = await told(db, workspaceId, ada.userId, { read: true, title: 'second' });
      const third = await told(db, workspaceId, ada.userId, { title: 'third' });
      await told(db, workspaceId, bob.userId, { title: 'bob’s' });
      const page = await inboxPage(db, ada.context, RUNNING, {});
      expect(Value.Check(InboxPage, page)).toBe(true);
      expect(page.data.map((entry) => entry.id)).toEqual([third, second, first]);
      expect(page.unreadCount).toBe(2);
      expect(page.nextCursor).toBeNull();
      expect(page.data[0]).toMatchObject({
        module: 'things',
        kind: 'thing_assigned',
        params: { title: 'third' },
        readAt: null,
      });
      expect(page.data[1]?.readAt).not.toBeNull();
      expect(JSON.stringify(page)).not.toContain('bob’s');
    });
  });

  test('keeps to the workspace asked for: a person of two sees one at a time', async () => {
    await withRollback(async (db) => {
      const here = await aWorkspace(db);
      const there = await aWorkspace(db);
      const ada = await aMember(db, here, 'ada');
      const adaThere = await aMember(db, there, 'ada-there');
      await db
        .updateTable('workspace_members')
        .set({ user_id: ada.userId })
        .where('user_id', '=', adaThere.userId)
        .execute();
      const onThisSide = await told(db, here, ada.userId);
      await told(db, there, ada.userId);
      const page = await inboxPage(db, ada.context, RUNNING, {});
      expect(page.data.map((entry) => entry.id)).toEqual([onThisSide]);
      expect(page.unreadCount).toBe(1);
    });
  });

  test('lists and counts only the modules that run: another’s rows are kept and unseen', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const shown = await told(db, workspaceId, ada.userId);
      await told(db, workspaceId, ada.userId, { module: 'gone' });
      const page = await inboxPage(db, ada.context, RUNNING, {});
      expect(page.data.map((entry) => entry.id)).toEqual([shown]);
      expect(page.unreadCount).toBe(1);
      expect(await inboxPage(db, ada.context, [], {})).toEqual({
        data: [],
        nextCursor: null,
        unreadCount: 0,
      });
      expect(
        await db
          .selectFrom('inbox_entries')
          .select('id')
          .where('user_id', '=', ada.userId)
          .execute(),
      ).toHaveLength(2);
    });
  });

  test('pages by keyset: zero, one, exactly a page, a page and one', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      expect(await inboxPage(db, ada.context, RUNNING, { limit: 2 })).toEqual({
        data: [],
        nextCursor: null,
        unreadCount: 0,
      });
      const ids: string[] = [];
      for (let at = 0; at < 5; at += 1) ids.unshift(await told(db, workspaceId, ada.userId));
      const one = await inboxPage(db, ada.context, RUNNING, { limit: 1 });
      expect(one.data.map((entry) => entry.id)).toEqual(ids.slice(0, 1));
      expect(one.nextCursor).toBe(ids[0] ?? '');
      const exact = await inboxPage(db, ada.context, RUNNING, { limit: 5 });
      expect(exact.data).toHaveLength(5);
      expect(exact.nextCursor).toBeNull();
      const firstPage = await inboxPage(db, ada.context, RUNNING, { limit: 2 });
      expect(firstPage.data.map((entry) => entry.id)).toEqual(ids.slice(0, 2));
      const next = await inboxPage(db, ada.context, RUNNING, {
        limit: 2,
        before: firstPage.nextCursor ?? '',
      });
      expect(next.data.map((entry) => entry.id)).toEqual(ids.slice(2, 4));
      const last = await inboxPage(db, ada.context, RUNNING, {
        limit: 2,
        before: next.nextCursor ?? '',
      });
      expect(last.data.map((entry) => entry.id)).toEqual(ids.slice(4));
      expect(last.nextCursor).toBeNull();
      // A limit past the contract's is held to it.
      const over = await inboxPage(db, ada.context, RUNNING, { limit: PAGE_LIMIT.max + 1 });
      expect(over.data).toHaveLength(5);
    });
  });

  test('unreadOnly leaves out what was read, and the count stays the whole’s', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      await told(db, workspaceId, ada.userId, { read: true });
      const unread = await told(db, workspaceId, ada.userId);
      const page = await inboxPage(db, ada.context, RUNNING, { unreadOnly: true });
      expect(page.data.map((entry) => entry.id)).toEqual([unread]);
      expect(page.unreadCount).toBe(1);
    });
  });

  test('a value in the column that is not short plain params is shown as none, not as a failure', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const id = await told(db, workspaceId, ada.userId);
      await db
        .updateTable('inbox_entries')
        .set({ params: JSON.stringify({ nested: { not: 'plain' } }) })
        .where('id', '=', id)
        .execute();
      expect((await inboxPage(db, ada.context, RUNNING, {})).data[0]?.params).toEqual({});
    });
  });
});

describe('integration: marking the inbox read', () => {
  test('reads the ids given, once, and answers how many it newly read', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const one = await told(db, workspaceId, ada.userId);
      const two = await told(db, workspaceId, ada.userId);
      expect(await markInboxRead(db, clock, ada.context, RUNNING, { ids: [one] })).toBe(1);
      expect(await markInboxRead(db, clock, ada.context, RUNNING, { ids: [one] })).toBe(0);
      const page = await inboxPage(db, ada.context, RUNNING, {});
      expect(page.unreadCount).toBe(1);
      expect(page.data.find((entry) => entry.id === one)?.readAt).toBe(NOW.toISOString());
      expect(page.data.find((entry) => entry.id === two)?.readAt).toBeNull();
    });
  });

  test('another person’s notice, another workspace’s and an id nobody has are not read and not reported', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const elsewhere = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      const bob = await aMember(db, workspaceId, 'bob');
      const adaElsewhere = await aMember(db, elsewhere, 'ada-else');
      const bobs = await told(db, workspaceId, bob.userId);
      const adasOther = await told(db, elsewhere, adaElsewhere.userId);
      const ids = [bobs, adasOther, crypto.randomUUID()];
      expect(await markInboxRead(db, clock, ada.context, RUNNING, { ids })).toBe(0);
      expect(await markInboxRead(db, clock, ada.context, RUNNING, { all: true })).toBe(0);
      const unread = await db
        .selectFrom('inbox_entries')
        .select('id')
        .where('read_at', 'is', null)
        .where('id', 'in', [bobs, adasOther])
        .execute();
      expect(unread).toHaveLength(2);
    });
  });

  test('all reads every unread notice of the caller in the workspace and no other, and a module that is off keeps its own unread', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const elsewhere = await aWorkspace(db);
      const ada = await aMember(db, workspaceId, 'ada');
      await told(db, workspaceId, ada.userId);
      await told(db, workspaceId, ada.userId);
      const hidden = await told(db, workspaceId, ada.userId, { module: 'gone' });
      const otherWorkspace = await told(db, elsewhere, ada.userId);
      expect(await markInboxRead(db, clock, ada.context, RUNNING, { all: true })).toBe(2);
      const kept = await db
        .selectFrom('inbox_entries')
        .select('id')
        .where('read_at', 'is', null)
        .where('user_id', '=', ada.userId)
        .execute();
      expect(kept.map((row) => row.id).sort()).toEqual([hidden, otherWorkspace].sort());
      expect(await markInboxRead(db, clock, ada.context, [], { all: true })).toBe(0);
    });
  });
});
