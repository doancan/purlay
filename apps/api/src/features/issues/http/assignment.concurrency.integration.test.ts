/**
 * An assignment and its notice are one commit (D-286): on a cloned database, because what a rollback leaves and what two
 * commits leave is the behaviour under test, and the harness's one rolled-back transaction has neither (D-46).
 *
 * @needs-modules issues
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { NO_LOG } from '../../../platform/events';
import type { NotificationSink } from '../../../platform/ports/notification-sink';
import { serverMetrics } from '../../../platform/metrics';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import { notificationSink } from '../../../modules/inbox/sink';
import { NOW } from '../../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../../testing/users';
import { createIssue, updateIssue } from '../issues';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const sink: NotificationSink = notificationSink({
  module: 'issues',
  clock: fixedClock(NOW),
  kinds: new Map([['issue_assigned', 'issues']]),
  pushedKinds: new Set(),
  bus: {
    publish: () => Promise.resolve(),
    subscribe: () => true,
    unsubscribe: () => undefined,
    forget: () => undefined,
  },
  log: NO_LOG,
  written: serverMetrics().inboxEntries,
  collapsed: serverMetrics().inboxCollapsed,
});

const aWorkspaceOf = async (): Promise<{ workspaceId: string; ada: string; bob: string }> => {
  const [ada, bob] = [await aUserRow(cloned.db, 'ada'), await aUserRow(cloned.db, 'bob')];
  const workspace = await cloned.db
    .insertInto('workspaces')
    .values({ name: 'W', slug: aUniqueSlug('asg') })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [who, role] of [
    [ada.userId, 'owner'],
    [bob.userId, 'member'],
  ] as const) {
    await cloned.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: who, role })
      .execute();
  }
  return { workspaceId: workspace.id, ada: ada.userId, bob: bob.userId };
};

const entriesFor = async (userId: string): Promise<number> =>
  (await cloned.db.selectFrom('inbox_entries').select('id').where('user_id', '=', userId).execute())
    .length;

describe('integration: an assignment and its notice, together', () => {
  test('a transaction that fails after the notice leaves neither the assignment nor the notice', async () => {
    const { workspaceId, ada, bob } = await aWorkspaceOf();
    const made = await atomicallyOn(cloned.db)(async (transaction) => {
      const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
      return (await createIssue(transaction, fixedClock(NOW), context, { title: 'Open' }, sink))
        .issue;
    });
    let failed: unknown;
    try {
      await atomicallyOn(cloned.db)(async (transaction) => {
        const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
        const { told } = await updateIssue(
          transaction,
          fixedClock(NOW),
          context,
          made.id,
          { assigneeId: bob },
          sink,
        );
        // The notice is written, in this transaction, and then something later fails.
        expect(told).toHaveLength(1);
        throw new Error('the commit never happens');
      });
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeInstanceOf(Error);
    const row = await cloned.db
      .selectFrom('issues')
      .select('assignee_id')
      .where('id', '=', made.id)
      .executeTakeFirstOrThrow();
    expect(row.assignee_id).toBeNull();
    expect(await entriesFor(bob)).toBe(0);
  });

  test('a notice that cannot be written takes the assignment with it', async () => {
    const { workspaceId, ada, bob } = await aWorkspaceOf();
    const made = await atomicallyOn(cloned.db)(async (transaction) => {
      const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
      return (await createIssue(transaction, fixedClock(NOW), context, { title: 'Open' }, sink))
        .issue;
    });
    const broken: NotificationSink = {
      notify: () => Promise.reject(new Error('the inbox is down')),
      announce: () => Promise.resolve(),
    };
    const outcome = await atomicallyOn(cloned.db)(async (transaction) => {
      const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
      return await updateIssue(
        transaction,
        fixedClock(NOW),
        context,
        made.id,
        { assigneeId: bob },
        broken,
      );
    }).catch((error: unknown) => (error instanceof Error ? error.message : 'other'));
    expect(outcome).toBe('the inbox is down');
    const row = await cloned.db
      .selectFrom('issues')
      .select('assignee_id')
      .where('id', '=', made.id)
      .executeTakeFirstOrThrow();
    expect(row.assignee_id).toBeNull();
  });

  test('a commit leaves both; two assignments of one issue to one person at once leave one unread notice', async () => {
    const { workspaceId, ada, bob } = await aWorkspaceOf();
    const made = await atomicallyOn(cloned.db)(async (transaction) => {
      const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
      return (await createIssue(transaction, fixedClock(NOW), context, { title: 'Open' }, sink))
        .issue;
    });
    const assign = async (): Promise<void> => {
      await atomicallyOn(cloned.db)(async (transaction) => {
        const context = await requireWorkspaceMembership(transaction, ada, workspaceId);
        await updateIssue(
          transaction,
          fixedClock(NOW),
          context,
          made.id,
          { assigneeId: bob },
          sink,
        );
        // Held a moment, so that the other has looked before this commits.
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    };
    await Promise.all([assign(), assign()]);
    const row = await cloned.db
      .selectFrom('issues')
      .select('assignee_id')
      .where('id', '=', made.id)
      .executeTakeFirstOrThrow();
    expect(row.assignee_id).toBe(bob);
    expect(await entriesFor(bob)).toBe(1);
  }, 60_000);
});
