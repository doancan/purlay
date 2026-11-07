/**
 * The core's inbox over HTTP, on a real database (D-286): who is told what, what a stranger and a signed-out caller get,
 * the contract's shape both ways, what is read, and what the person's other tabs are told.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, type Executor, withRollback } from '@purlay/db';
import { InboxPage, messageId, ServerFrame, type Topic } from '@purlay/types';
import { compositionFor } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { userTopic } from '../../platform/events';
import { inProcessBackplane, type Backplane } from '../../realtime/bus';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** What is published, with the bus as the application's own: the frames and the topics they went to. */
const published: [Topic, ServerFrame][] = [];
const recording: Backplane = {
  node: (deliver, log) => {
    const real = inProcessBackplane().node(deliver, log);
    return {
      ...real,
      publish: async (topic, frame): Promise<void> => {
        published.push([topic, frame]);
        await real.publish(topic, frame);
      },
    };
  },
};

const caller =
  (db: Executor, setting?: string) =>
  async (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
  ): Promise<Answer> => {
    const app = createApp(
      testDependencies({
        database: db,
        clock,
        backplane: recording,
        composition: compositionFor(setting),
      }),
    );
    const headers: Record<string, string> = who === null ? {} : { cookie: who.cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

const code = (answer: Answer): unknown =>
  (answer.body as { error?: { code?: string } }).error?.code;

const aWorkspace = async (db: Executor, who: SignedInUser[]): Promise<string> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Inbox', slug: aUniqueSlug('inbox') })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const person of who) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: person.userId, role: 'member' })
      .execute();
  }
  return workspace.id;
};

let tick = 0;
const told = async (
  db: Executor,
  workspaceId: string,
  who: SignedInUser,
  options: { module?: string; title?: string } = {},
): Promise<string> => {
  const at = new Date(NOW.getTime() + (tick += 10));
  const id = messageId(at);
  await db
    .insertInto('inbox_entries')
    .values({
      id,
      workspace_id: workspaceId,
      user_id: who.userId,
      module: options.module ?? 'issues',
      kind: 'issue_assigned',
      subject_type: 'issue',
      subject_id: crypto.randomUUID(),
      params: JSON.stringify({ title: options.title ?? 'Fix the build' }),
      created_at: at,
    })
    .execute();
  return id;
};

const inbox = (workspaceId: string): string => `/api/workspaces/${workspaceId}/inbox`;

describe('integration: the core’s inbox over HTTP', () => {
  test('lists the caller’s own notices in the contract’s shape, and nobody else’s', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const ada = await aSignedInUser(db, clock, 'ada');
      const bob = await aSignedInUser(db, clock, 'bob');
      const workspaceId = await aWorkspace(db, [ada, bob]);
      const mine = await told(db, workspaceId, ada, { title: 'for ada' });
      await told(db, workspaceId, bob, { title: 'for bob' });
      const answer = await call('GET', inbox(workspaceId), ada);
      expect(answer.status).toBe(200);
      expect(Value.Check(InboxPage, answer.body)).toBe(true);
      expect(answer.body).toMatchObject({
        data: [
          { id: mine, module: 'issues', kind: 'issue_assigned', params: { title: 'for ada' } },
        ],
        nextCursor: null,
        unreadCount: 1,
      });
      expect(JSON.stringify(answer.body)).not.toContain('for bob');
    });
  });

  test('is a person’s own in each workspace they are in: a notice of one is not in the other’s list or count', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const ada = await aSignedInUser(db, clock, 'ada');
      const here = await aWorkspace(db, [ada]);
      const there = await aWorkspace(db, [ada]);
      const hers = await told(db, here, ada, { title: 'here' });
      await told(db, there, ada, { title: 'there' });
      await told(db, there, ada, { title: 'there too' });
      const answer = await call('GET', inbox(here), ada);
      expect(answer.body).toMatchObject({ data: [{ id: hers }], unreadCount: 1 });
      const other = await call('GET', inbox(there), ada);
      expect((other.body as InboxPage).data).toHaveLength(2);
      expect((other.body as InboxPage).unreadCount).toBe(2);
    });
  });

  test('a signed-out caller is asked to sign in, and a stranger is told the workspace does not exist, as for one that never did', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const ada = await aSignedInUser(db, clock, 'ada');
      const eve = await aSignedInUser(db, clock, 'eve');
      const workspaceId = await aWorkspace(db, [ada]);
      await told(db, workspaceId, ada);
      expect((await call('GET', inbox(workspaceId), null)).status).toBe(401);
      expect((await call('POST', `${inbox(workspaceId)}/read`, null, { all: true })).status).toBe(
        401,
      );
      const stranger = await call('GET', inbox(workspaceId), eve);
      const never = await call('GET', inbox(crypto.randomUUID()), eve);
      expect([stranger.status, code(stranger)]).toEqual([404, 'WORKSPACE_NOT_FOUND']);
      expect(stranger.body).toEqual(never.body);
      const read = await call('POST', `${inbox(workspaceId)}/read`, eve, { all: true });
      expect([read.status, code(read)]).toEqual([404, 'WORKSPACE_NOT_FOUND']);
      expect((await call('GET', inbox('not-a-workspace'), eve)).status).toBe(404);
    });
  });

  test('refuses a query or a body that does not match the contract, by name, and reads nothing', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const ada = await aSignedInUser(db, clock, 'ada');
      const workspaceId = await aWorkspace(db, [ada]);
      const id = await told(db, workspaceId, ada);
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=1.5',
        'limit=abc',
        'unreadOnly=maybe',
        'before=not-an-id',
        'unknown=1',
        'limit=1&limit=2',
      ]) {
        const answer = await call('GET', `${inbox(workspaceId)}?${query}`, ada);
        expect({ query, status: answer.status, code: code(answer) }).toEqual({
          query,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
      for (const body of [
        {},
        { ids: [] },
        { ids: ['not-an-id'] },
        { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) },
        { all: false },
        { all: true, ids: [id] },
        { ids: [id], extra: 1 },
        'text',
      ]) {
        const answer = await call('POST', `${inbox(workspaceId)}/read`, ada, body);
        expect({ status: answer.status, code: code(answer) }).toEqual({
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
      const after = await call('GET', inbox(workspaceId), ada);
      expect(after.body).toMatchObject({ unreadCount: 1 });
    });
  });

  test('reads what is asked, once: 204, again 204, and the other tabs are told only the first time', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const ada = await aSignedInUser(db, clock, 'ada');
      const bob = await aSignedInUser(db, clock, 'bob');
      const workspaceId = await aWorkspace(db, [ada, bob]);
      const one = await told(db, workspaceId, ada);
      await told(db, workspaceId, ada);
      const bobs = await told(db, workspaceId, bob);
      published.splice(0);
      const first = await call('POST', `${inbox(workspaceId)}/read`, ada, { ids: [one] });
      expect(first).toEqual({ status: 204, body: null });
      expect(published).toEqual([
        [
          userTopic(ada.userId),
          { event: 'INBOX_UPDATED', data: { workspaceId }, ts: NOW.getTime() },
        ],
      ]);
      for (const [, frame] of published) expect(Value.Check(ServerFrame, frame)).toBe(true);
      published.splice(0);
      expect(await call('POST', `${inbox(workspaceId)}/read`, ada, { ids: [one] })).toEqual({
        status: 204,
        body: null,
      });
      expect(published).toEqual([]);
      const list = await call('GET', inbox(workspaceId), ada);
      expect((list.body as InboxPage).unreadCount).toBe(1);

      // Another person's notice is not read, and nothing says whether it exists.
      const foreign = await call('POST', `${inbox(workspaceId)}/read`, ada, { ids: [bobs] });
      expect(foreign.status).toBe(204);
      expect(published).toEqual([]);
      expect((await call('GET', inbox(workspaceId), bob)).body).toMatchObject({ unreadCount: 1 });

      const all = await call('POST', `${inbox(workspaceId)}/read`, ada, { all: true });
      expect(all.status).toBe(204);
      expect((await call('GET', inbox(workspaceId), ada)).body).toMatchObject({ unreadCount: 0 });
      expect(published).toHaveLength(1);
    });
  });

  test('a process that does not run a module lists none of its notices, and does not read them away', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'ada');
      const workspaceId = await aWorkspace(db, [ada]);
      const issues = await told(db, workspaceId, ada, { module: 'issues' });
      const withIssues = caller(db);
      const without = caller(db, 'chat');
      const none = caller(db, 'none');
      expect((await withIssues('GET', inbox(workspaceId), ada)).body).toMatchObject({
        data: [{ id: issues }],
        unreadCount: 1,
      });
      expect((await without('GET', inbox(workspaceId), ada)).body).toEqual({
        data: [],
        nextCursor: null,
        unreadCount: 0,
      });
      expect((await none('GET', inbox(workspaceId), ada)).status).toBe(200);
      expect((await without('POST', `${inbox(workspaceId)}/read`, ada, { all: true })).status).toBe(
        204,
      );
      // Still there, and still unread, for the day the module runs again.
      expect((await withIssues('GET', inbox(workspaceId), ada)).body).toMatchObject({
        data: [{ id: issues, readAt: null }],
        unreadCount: 1,
      });
    });
  });
});
