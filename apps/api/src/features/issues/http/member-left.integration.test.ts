/**
 * A person who stops being a member is taken off the workspace's open issues (D-355): the core's `core.member-left`, published where
 * the membership is deleted, delivered to issues' consumer by its `outbox:consume` worker. Committed for real, on a database of its own,
 * since the delivery claims and marks rows in transactions of its own.
 *
 * @needs-modules chat, issues
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { CORE_MEMBER_LEFT, messageId, type UserRole } from '@purlay/types';
import { composition, compositionFor } from '../../../composition';
import { createApp } from '../../../ingress/http/app';
import { NOW, aMovableClock, testDependencies } from '../../../testing/doubles';
import { deliverPending, publishAndDeliver } from '../../../testing/fact-delivery';
import { aGrant } from '../../../testing/facts';
import { aSignedInUser, type SignedInUser } from '../../../testing/signed-in';
import { aUniqueSlug } from '../../../testing/users';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const clock = aMovableClock(NOW);

interface Workspace {
  readonly id: string;
  readonly people: Readonly<Record<string, SignedInUser>>;
}

const aWorkspace = async (
  db: Executor,
  roles: Readonly<Record<string, UserRole>>,
  people: Readonly<Record<string, SignedInUser>> = {},
): Promise<Workspace> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Issues', slug: aUniqueSlug('gone') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const all: Record<string, SignedInUser> = { ...people };
  for (const [name, role] of Object.entries(roles)) {
    const person = all[name] ?? (await aSignedInUser(db, clock, name));
    all[name] = person;
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: person.userId, role })
      .execute();
  }
  return { id: workspace.id, people: all };
};

const who = (workspace: Workspace, name: string): SignedInUser => {
  const found = workspace.people[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

/** An issue of the workspace as a test needs one: its status and assignee, made by nobody in particular. */
const anIssue = async (
  workspace: Workspace,
  status: 'open' | 'done',
  assigneeId: string | null,
): Promise<string> => {
  clock.advance(1);
  const at = clock.now();
  const row = await cloned.db
    .insertInto('issues')
    .values({
      id: messageId(at),
      workspace_id: workspace.id,
      title: `An ${status} issue`,
      status,
      assignee_id: assigneeId,
      created_at: at,
      updated_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const assigneeOf = async (issueId: string): Promise<string | null> =>
  (
    await cloned.db
      .selectFrom('issues')
      .select('assignee_id')
      .where('id', '=', issueId)
      .executeTakeFirstOrThrow()
  ).assignee_id;

const trailOf = async (
  workspaceId: string,
): Promise<
  readonly { target_id: string | null; actor_user_id: string | null; metadata: unknown }[]
> =>
  await cloned.db
    .selectFrom('audit_log')
    .select(['target_id', 'actor_user_id', 'metadata'])
    .where('workspace_id', '=', workspaceId)
    .where('action', '=', 'issue.assigned')
    .execute();

const leave = async (workspace: Workspace, name: string): Promise<void> => {
  const app = createApp(testDependencies({ database: cloned.db, clock, composition }));
  const response = await app.handle(
    new Request(`https://purlay.test/api/workspaces/${workspace.id}/membership`, {
      method: 'DELETE',
      headers: { cookie: who(workspace, name).cookie },
    }),
  );
  expect(response.status).toBe(204);
};

const outboxStates = async (workspaceId: string): Promise<readonly string[]> =>
  (
    await cloned.db
      .selectFrom('outbox')
      .select('state')
      .where('workspace_id', '=', workspaceId)
      .where('type', '=', CORE_MEMBER_LEFT.type)
      .execute()
  ).map(({ state }) => state);

describe('integration: a member who leaves is taken off their open issues (D-355)', () => {
  test('leaving, then the delivery, unassigns only their open issues of that workspace, on the trail with nobody as the actor', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const elsewhere = await aWorkspace(cloned.db, { bob: 'owner' }, w.people);
    const [ada, bob] = [who(w, 'ada').userId, who(w, 'bob').userId];
    const open = await anIssue(w, 'open', bob);
    const done = await anIssue(w, 'done', bob);
    const adas = await anIssue(w, 'open', ada);
    const theirs = await anIssue(elsewhere, 'open', bob);
    await leave(w, 'bob');
    expect(await outboxStates(w.id)).toEqual(['pending']);
    // Until it is delivered nothing has changed: the fact is the only thing the leaving wrote of issues.
    expect(await assigneeOf(open)).toBe(bob);
    clock.advance(1_000);
    await deliverPending(cloned.db, composition, { clock });
    expect(await outboxStates(w.id)).toEqual(['delivered']);
    expect({
      open: await assigneeOf(open),
      done: await assigneeOf(done),
      adas: await assigneeOf(adas),
      theirs: await assigneeOf(theirs),
    }).toEqual({ open: null, done: bob, adas: ada, theirs: bob });
    const changed = await cloned.db
      .selectFrom('issues')
      .select('updated_at')
      .where('id', '=', open)
      .executeTakeFirstOrThrow();
    expect(changed.updated_at).toEqual(clock.now());
    expect(await trailOf(w.id)).toEqual([
      { target_id: open, actor_user_id: null, metadata: { from: bob, to: '' } },
    ]);
    expect(await trailOf(elsewhere.id)).toEqual([]);
  });

  test('the same fact delivered again changes nothing and writes nothing more', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob').userId;
    const open = await anIssue(w, 'open', bob);
    await cloned.db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', w.id)
      .where('user_id', '=', bob)
      .execute();
    const payload = { userId: bob, reason: 'removed' as const };
    for (let delivery = 1; delivery <= 2; delivery += 1) {
      clock.advance(1_000);
      expect(
        await publishAndDeliver(cloned.db, composition, {
          workspaceId: w.id,
          fact: CORE_MEMBER_LEFT,
          payload,
          clock,
        }),
      ).toEqual({ issues: 'delivered' });
    }
    expect(await assigneeOf(open)).toBeNull();
    expect(await trailOf(w.id)).toHaveLength(1);
  });

  test('a person who came back before the delivery keeps what they hold; one back as a guest kept out of issues does not', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member', cy: 'member' });
    const [bob, cy] = [who(w, 'bob').userId, who(w, 'cy').userId];
    const bobs = await anIssue(w, 'open', bob);
    const cys = await anIssue(w, 'open', cy);
    await leave(w, 'bob');
    await leave(w, 'cy');
    await cloned.db
      .insertInto('workspace_members')
      .values([
        { workspace_id: w.id, user_id: bob, role: 'member' },
        {
          workspace_id: w.id,
          user_id: cy,
          role: 'member',
          access_kind: 'guest',
          guest_since: new Date(0),
          guest_modules: ['chat'],
        },
      ])
      .execute();
    clock.advance(1_000);
    await deliverPending(cloned.db, composition, { clock });
    expect((await outboxStates(w.id)).toSorted()).toEqual(['delivered', 'skipped']);
    expect({ bob: await assigneeOf(bobs), cy: await assigneeOf(cys) }).toEqual({
      bob,
      cy: null,
    });
  });

  test('a workspace not granted issues is told nothing, and its issues stay as they were', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob').userId;
    const open = await anIssue(w, 'open', bob);
    await aGrant(cloned.db, w.id, 'issues', 'off');
    await leave(w, 'bob');
    expect(await outboxStates(w.id)).toEqual([]);
    expect(await assigneeOf(open)).toBe(bob);
  });

  test('a node that does not run issues holds the fact, and a node that does delivers it', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob').userId;
    const open = await anIssue(w, 'open', bob);
    const chatOnly = compositionFor('chat');
    const app = createApp(testDependencies({ database: cloned.db, clock, composition: chatOnly }));
    const response = await app.handle(
      new Request(`https://purlay.test/api/workspaces/${w.id}/membership`, {
        method: 'DELETE',
        headers: { cookie: who(w, 'bob').cookie },
      }),
    );
    expect(response.status).toBe(204);
    clock.advance(1_000);
    await deliverPending(cloned.db, chatOnly, { clock });
    expect(await outboxStates(w.id)).toEqual(['pending']);
    expect(await assigneeOf(open)).toBe(bob);
    await deliverPending(cloned.db, composition, { clock });
    expect(await outboxStates(w.id)).toEqual(['delivered']);
    expect(await assigneeOf(open)).toBeNull();
  });
});
