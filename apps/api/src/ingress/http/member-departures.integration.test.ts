/**
 * A person who stops being a member is a fact the modules are told, `core.member-left`, written in the transaction that removed
 * them and in no other (D-355): leaving and a removal over HTTP each write exactly one, a refused one writes none, and a removal
 * whose transaction rolls back leaves neither the departure nor the fact. Committed for real, on a database of its own, so a
 * rollback is a rollback.
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
import type { UserRole } from '@purlay/types';
import { composition } from '../../composition';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { createApp } from './app';
import { factContextOf } from '../../module-seams-wiring';
import { OUTBOX_PENDING_MAX_DEFAULT } from '../../platform/config';
import { serverMetrics } from '../../platform/metrics';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { NOW, aMovableClock, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { memberDeparturesOf } from '../../modules/workspaces/member-departures';
import { removeMember } from '../../modules/workspaces/members';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const clock = aMovableClock(NOW);

const call = async (
  method: string,
  path: string,
  who: SignedInUser,
): Promise<{ readonly status: number }> => {
  const app = createApp(testDependencies({ database: cloned.db, clock, composition }));
  const response = await app.handle(
    new Request(`https://purlay.test${path}`, { method, headers: { cookie: who.cookie } }),
  );
  return { status: response.status };
};

/** A workspace whose people have the roles given. */
const aWorkspace = async (
  db: Executor,
  roles: Readonly<Record<string, UserRole>>,
): Promise<{ readonly id: string; readonly people: Readonly<Record<string, SignedInUser>> }> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Departures', slug: aUniqueSlug('left') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const people: Record<string, SignedInUser> = {};
  for (const [name, role] of Object.entries(roles)) {
    const person = await aSignedInUser(db, clock, name);
    people[name] = person;
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: person.userId, role })
      .execute();
  }
  return { id: workspace.id, people };
};

const who = (
  workspace: { readonly people: Readonly<Record<string, SignedInUser>> },
  name: string,
): SignedInUser => {
  const found = workspace.people[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

/** The workspace's `core.member-left` rows, as each consumer got one. */
const factsOf = async (
  workspaceId: string,
): Promise<readonly { consumer: string; producer: string; payload: unknown }[]> =>
  await cloned.db
    .selectFrom('outbox')
    .select(['consumer', 'producer', 'payload'])
    .where('workspace_id', '=', workspaceId)
    .where('type', '=', 'core.member-left')
    .execute();

const isMember = async (workspaceId: string, userId: string): Promise<boolean> =>
  (await cloned.db
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) !== undefined;

describe('integration: the modules are told who left a workspace (D-355)', () => {
  test('leaving writes one fact, as the core, for the consumer the build has, saying the person left', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob');
    expect((await call('DELETE', `/api/workspaces/${w.id}/membership`, bob)).status).toBe(204);
    expect(await isMember(w.id, bob.userId)).toBe(false);
    expect(await factsOf(w.id)).toEqual([
      { consumer: 'issues', producer: 'core', payload: { userId: bob.userId, reason: 'left' } },
    ]);
  });

  test('a removal by an admin writes one fact saying the person was removed', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob');
    expect(
      (await call('DELETE', `/api/workspaces/${w.id}/members/${bob.userId}`, who(w, 'ada'))).status,
    ).toBe(204);
    expect(await factsOf(w.id)).toEqual([
      { consumer: 'issues', producer: 'core', payload: { userId: bob.userId, reason: 'removed' } },
    ]);
  });

  test('a refused removal or leaving writes nothing: a member removing another, the last owner leaving', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member', cy: 'member' });
    expect(
      (
        await call(
          'DELETE',
          `/api/workspaces/${w.id}/members/${who(w, 'cy').userId}`,
          who(w, 'bob'),
        )
      ).status,
    ).toBe(403);
    expect((await call('DELETE', `/api/workspaces/${w.id}/membership`, who(w, 'ada'))).status).toBe(
      409,
    );
    expect(await factsOf(w.id)).toEqual([]);
  });

  test('a removal whose transaction rolls back leaves the member, and no fact of their leaving', async () => {
    const w = await aWorkspace(cloned.db, { ada: 'owner', bob: 'member' });
    const bob = who(w, 'bob');
    const departures = memberDeparturesOf(
      factContextOf({
        composition,
        clock,
        metrics: serverMetrics(),
        outboxPendingMax: OUTBOX_PENDING_MAX_DEFAULT,
        deliveriesPerMinuteMax: null,
      }),
    );
    const removeBob = async (then: () => void): Promise<void> => {
      await atomicallyOn(cloned.db)(async (transaction) => {
        const ada = await requireWorkspaceMembership(transaction, who(w, 'ada').userId, w.id);
        await removeMember(transaction, clock, ada, bob.userId, chatWorkspaceChannels, departures);
        then();
      });
    };
    const failure = new Error('something after the removal failed');
    expect(
      await removeBob(() => {
        throw failure;
      }).catch((error: unknown) => error),
    ).toBe(failure);
    expect(await isMember(w.id, bob.userId)).toBe(true);
    expect(await factsOf(w.id)).toEqual([]);
    // The same removal committed is the fact, once.
    await removeBob(() => undefined);
    expect(await isMember(w.id, bob.userId)).toBe(false);
    expect(await factsOf(w.id)).toHaveLength(1);
  });
});
