/**
 * The most deliveries a workspace may queue in one minute (#1306): the default the process is given, the operator's override of one
 * workspace, and the window that moves with the clock. Real PostgreSQL; the rows are read back by what the table holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { aMovableClock, NOW } from '../testing/doubles';
import { aPublishWorld, aWorkspaceRow, NOTE_CREATED, NOTE_PINNED } from '../testing/facts';
import { messageId } from '@purlay/types';
import { withinRequest } from './logging';
import { FactRateExceeded, publishFact } from './outbox';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const refusalOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const countOf = async (db: Executor, workspaceId: string): Promise<number> =>
  (await db.selectFrom('outbox').select('id').where('workspace_id', '=', workspaceId).execute())
    .length;

const override = async (
  db: Executor,
  workspaceId: string,
  limit: number,
  kind = 'deliveries_per_minute',
): Promise<void> => {
  await db
    .insertInto('workspace_quotas')
    .values({
      workspace_id: workspaceId,
      kind,
      limit_value: String(limit),
      reason: 'a test',
      changed_at: NOW,
    })
    .execute();
};

/** A client's request: the rate bounds what one makes the workspace publish. */
const inARequest = <T>(work: () => Promise<T>): Promise<T> =>
  withinRequest({ requestId: 'req-rate', startedAt: 0, module: 'notes' }, work);

/** `notes.pinned` is wiki's alone: one row for each publish, here made in a request. */
const pin = async (
  db: Transaction,
  workspaceId: string,
  clock: ReturnType<typeof aMovableClock>,
  fallback: number | null,
): Promise<void> => {
  const { context } = aPublishWorld(workspaceId, clock);
  await inARequest(async () => {
    await publishFact(db, { ...context, deliveriesPerMinuteMax: fallback }, NOTE_PINNED, {
      noteId: 'n',
    });
  });
};

describe('integration: the deliveries a workspace may queue in a minute', () => {
  test('takes what reaches the default exactly and refuses the next, naming the workspace and the limit, and writes nothing of it', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await pin(tx, workspaceId, clock, 2);
      await pin(tx, workspaceId, clock, 2);
      const refused = await refusalOf(pin(tx, workspaceId, clock, 2));
      expect(refused).toBeInstanceOf(FactRateExceeded);
      expect(refused).toMatchObject({ workspaceId, limit: 2, type: 'notes.pinned' });
      expect(await countOf(tx, workspaceId)).toBe(2);
    }, cloned.db);
  });

  test('counts the rows a fact would write, all or nothing: a fact with two consumers needs room for both', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await pin(tx, workspaceId, clock, 2);
      const { context } = aPublishWorld(workspaceId, clock);
      // One row is queued and the limit is two: notes.created would write two more.
      const refused = await refusalOf(
        inARequest(async () => {
          await publishFact(tx, { ...context, deliveriesPerMinuteMax: 2 }, NOTE_CREATED, {
            noteId: 'n',
            title: 't',
          });
        }),
      );
      expect(refused).toBeInstanceOf(FactRateExceeded);
      expect(await countOf(tx, workspaceId)).toBe(1);
    }, cloned.db);
  });

  test('is one for each workspace: a workspace at its limit does not stop its neighbour', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const mine = await aWorkspaceRow(tx);
      const theirs = await aWorkspaceRow(tx);
      await pin(tx, mine, clock, 1);
      expect(await refusalOf(pin(tx, mine, clock, 1))).toBeInstanceOf(FactRateExceeded);
      await pin(tx, theirs, clock, 1);
      expect(await countOf(tx, theirs)).toBe(1);
    }, cloned.db);
  });

  test('is not a limit where nothing sets one', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      for (let index = 0; index < 5; index += 1) await pin(tx, workspaceId, clock, null);
      expect(await countOf(tx, workspaceId)).toBe(5);
    }, cloned.db);
  });

  test('moves with the clock: what was queued more than a minute ago is not counted', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await pin(tx, workspaceId, clock, 1);
      expect(await refusalOf(pin(tx, workspaceId, clock, 1))).toBeInstanceOf(FactRateExceeded);
      clock.advance(59_000);
      expect(await refusalOf(pin(tx, workspaceId, clock, 1))).toBeInstanceOf(FactRateExceeded);
      clock.advance(2_000);
      await pin(tx, workspaceId, clock, 1);
      expect(await countOf(tx, workspaceId)).toBe(2);
    }, cloned.db);
  });

  test('the operator’s override of one workspace beats the default, up and down, and not for another', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const raised = await aWorkspaceRow(tx);
      const lowered = await aWorkspaceRow(tx);
      const plain = await aWorkspaceRow(tx);
      await override(tx, raised, 4);
      await override(tx, lowered, 1);
      for (let index = 0; index < 4; index += 1) await pin(tx, raised, clock, 1);
      expect(await refusalOf(pin(tx, raised, clock, 1))).toBeInstanceOf(FactRateExceeded);
      await pin(tx, lowered, clock, 3);
      expect(await refusalOf(pin(tx, lowered, clock, 3))).toBeInstanceOf(FactRateExceeded);
      // The default is the one the process is given; the others' overrides are not its.
      await pin(tx, plain, clock, 3);
      await pin(tx, plain, clock, 3);
      await pin(tx, plain, clock, 3);
      expect(await refusalOf(pin(tx, plain, clock, 3))).toBeInstanceOf(FactRateExceeded);
    }, cloned.db);
  });

  test('an override of none at all is a limit: 0 refuses every new delivery, even where the default is none', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await override(tx, workspaceId, 0);
      expect(await refusalOf(pin(tx, workspaceId, clock, null))).toBeInstanceOf(FactRateExceeded);
      expect(await countOf(tx, workspaceId)).toBe(0);
    }, cloned.db);
  });

  test('moves exactly at the minute: what was queued a minute ago to the millisecond is not counted, a millisecond sooner is', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await pin(tx, workspaceId, clock, 1);
      clock.advance(59_999);
      expect(await refusalOf(pin(tx, workspaceId, clock, 1))).toBeInstanceOf(FactRateExceeded);
      clock.advance(1);
      await pin(tx, workspaceId, clock, 1);
      expect(await countOf(tx, workspaceId)).toBe(2);
    }, cloned.db);
  });

  test('is a bound on what a client makes the workspace publish: what the system publishes in answer is not refused, so it is not given up on', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await override(tx, workspaceId, 0);
      const { context } = aPublishWorld(workspaceId, clock);
      // A delivery's: the fact it publishes names the fact whose delivery made it.
      await inARequest(async () => {
        await publishFact(
          tx,
          { ...context, causedBy: messageId(NOW), deliveriesPerMinuteMax: 0 },
          NOTE_PINNED,
          { noteId: 'answer' },
        );
      });
      // A worker's, or a job's: no request at all.
      await publishFact(tx, { ...context, deliveriesPerMinuteMax: 0 }, NOTE_PINNED, {
        noteId: 'timer',
      });
      expect(await countOf(tx, workspaceId)).toBe(2);
      // And the client's own, with the same limit, is refused.
      expect(await refusalOf(pin(tx, workspaceId, clock, 0))).toBeInstanceOf(FactRateExceeded);
    }, cloned.db);
  });

  test('reads the workspace’s own row of the kind asked, and no other kind’s: an issues limit is not the deliveries limit', async () => {
    await withRollback(async (tx) => {
      const clock = aMovableClock(NOW);
      const workspaceId = await aWorkspaceRow(tx);
      await override(tx, workspaceId, 0, 'issues:rows');
      // Only the issues limit is set, and it is 0: the deliveries are on their default, here none.
      await pin(tx, workspaceId, clock, null);
      expect(await countOf(tx, workspaceId)).toBe(1);
    }, cloned.db);
  });
});
