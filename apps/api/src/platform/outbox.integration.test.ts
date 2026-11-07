/**
 * A fact is told in the transaction that made it true (D-288, D-283 §2): one row for each module that consumes it, none when the
 * publisher's transaction ends without committing, and none that the table, the declaration or the caller's name would refuse.
 * Real PostgreSQL; the rows are read back by what the table holds, not by what `publishFact` says it did.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  closeIntegrationDatabase,
  isTransaction,
  withRollback,
  type ClonedDatabase,
  type Executor,
  type Outbox,
  type Selectable,
} from '@purlay/db';
import { messageId, messageIdTime } from '@purlay/types';
import { aMovableClock, NOW } from '../testing/doubles';
import {
  aPublishWorld,
  aWorkspaceRow,
  NOTE_CREATED,
  NOTE_CREATED_V2,
  NOTE_PINNED,
  NOTES,
  WIKI,
} from '../testing/facts';
import { DAY_MS } from './clock';
import { withinRequest } from './logging';
import {
  FactPublishError,
  OUTBOX_PAYLOAD_BYTES_MAX,
  factRoutingOf,
  publishFact,
  purgeWorkspaceFacts,
} from './outbox';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const clock = aMovableClock(NOW);
/** What a promise was refused with, or `undefined` when it was not: the way a refusal is asserted on here. */
const refusalOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const rowsOf = async (db: Executor, workspaceId: string): Promise<Selectable<Outbox>[]> =>
  await db.selectFrom('outbox').selectAll().where('workspace_id', '=', workspaceId).execute();

describe('integration: publishing a fact', () => {
  test('writes one row for each module that consumes it, with one fact id between them and the publisher’s workspace', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock);
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n1', title: 'Plan' });
      const rows = await rowsOf(tx, workspaceId);
      expect(
        rows
          .map((row) => [row.consumer, row.type, row.producer, row.state])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ['shelf', 'notes.created', 'notes', 'pending'],
        ['wiki', 'notes.created', 'notes', 'pending'],
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          payload: { noteId: 'n1', title: 'Plan' },
          attempts: 0,
          workspace_id: workspaceId,
          finished_at: null,
        });
        expect(row.next_attempt_at).toEqual(NOW);
      }
      expect(messageIdTime(rows[0]?.fact_id ?? '')).toBe(NOW.getTime());
      expect(new Set(rows.map((row) => row.fact_id)).size).toBe(1);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    }, cloned.db);
  });

  test('notes the request that published it and the fact whose delivery did, so a log can follow the chain', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock);
      const causedBy = messageId(NOW);
      await withinRequest(
        { requestId: 'req-'.padEnd(100, 'x'), startedAt: 0, module: 'notes' },
        () =>
          publishFact(tx, { ...context, causedBy }, NOTE_CREATED, { noteId: 'n1', title: 'Plan' }),
      );
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'n1' });
      const rows = await rowsOf(tx, workspaceId);
      const created = rows.filter((row) => row.type === 'notes.created');
      expect(created.map((row) => [row.correlation_id, row.caused_by])).toEqual([
        ['req-'.padEnd(64, 'x'), causedBy],
        ['req-'.padEnd(64, 'x'), causedBy],
      ]);
      expect(rows.find((row) => row.type === 'notes.pinned')).toMatchObject({
        correlation_id: null,
        caused_by: null,
      });
    }, cloned.db);
  });

  test('says which shape of its declaration wrote it, the first unless the declaration is a later one', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock);
      await publishFact(tx, context, NOTE_CREATED_V2, { noteId: 'n', title: 't', folder: 'f' });
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'n' });
      const shapes = (await rowsOf(tx, workspaceId)).map((row) => [row.type, row.shape].join(':'));
      expect(shapes.sort()).toEqual(['notes.created:2', 'notes.created:2', 'notes.pinned:1']);
    }, cloned.db);
  });

  test('writes no row for a consumer the workspace is not entitled to, and a row for the others', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock);
      const asked: string[] = [];
      const entitled = (workspace: string, module: string): boolean => {
        asked.push(`${workspace}:${module}`);
        return module !== 'wiki';
      };
      await publishFact(tx, { ...context, entitled }, NOTE_CREATED, { noteId: 'n', title: 't' });
      expect((await rowsOf(tx, workspaceId)).map((row) => row.consumer)).toEqual(['shelf']);
      expect(asked.sort()).toEqual([`${workspaceId}:shelf`, `${workspaceId}:wiki`]);
    }, cloned.db);
  });

  test('is gone with the publisher’s transaction when that does not commit, and there when it does', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    const failed = await refusalOf(
      cloned.db.transaction().execute(async (tx) => {
        await publishFact(tx, context, NOTE_CREATED, { noteId: 'n1', title: 'Plan' });
        throw new Error('the publisher fails after publishing');
      }),
    );
    expect(String(failed)).toContain('the publisher fails');
    expect(await rowsOf(cloned.db, workspaceId)).toEqual([]);

    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n2', title: 'Plan' });
    });
    expect(await rowsOf(cloned.db, workspaceId)).toHaveLength(2);
  });

  test('is never written through the pool: a handle that is no transaction is refused before anything is', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    expect(isTransaction(cloned.db)).toBe(false);
    const refused = await refusalOf(
      // @ts-expect-error a pool is not a transaction: this must not compile
      publishFact(cloned.db, context, NOTE_CREATED, { noteId: 'n', title: 't' }),
    );
    expect(refused).toBeInstanceOf(FactPublishError);
    expect(await rowsOf(cloned.db, workspaceId)).toEqual([]);
  });

  test('writes nothing for a fact nobody consumes', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context, droppedCount } = aPublishWorld(workspaceId, clock);
      const loner = {
        ...context,
        routing: { ...context.routing, consumersOf: (): readonly string[] => [] },
      };
      await publishFact(tx, loner, NOTE_CREATED, { noteId: 'n1', title: 'Plan' });
      expect(await rowsOf(tx, workspaceId)).toEqual([]);
      expect(droppedCount('wiki')).toBe(0);
    }, cloned.db);
  });
});

describe('integration: a consumer that this process does not run', () => {
  test('gets no row for a fact that says drop, and the count says so', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context, droppedCount } = aPublishWorld(workspaceId, clock, [NOTES]);
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n1', title: 'Plan' });
      expect(await rowsOf(tx, workspaceId)).toEqual([]);
      expect(droppedCount('wiki')).toBe(1);
    }, cloned.db);
  });

  test('gets a row for a fact that says holdDays, which expires that many days on', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context, droppedCount } = aPublishWorld(workspaceId, clock, [NOTES]);
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'n1' });
      const rows = await rowsOf(tx, workspaceId);
      expect(rows.map((row) => row.consumer)).toEqual(['wiki']);
      expect(rows[0]?.expires_at).toEqual(new Date(NOW.getTime() + 3 * DAY_MS));
      expect(droppedCount('wiki')).toBe(0);
    }, cloned.db);
  });

  test('is run by this process or not at the moment of publishing: a dropped fact is not written later', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      await publishFact(tx, aPublishWorld(workspaceId, clock, [NOTES]).context, NOTE_CREATED, {
        noteId: 'a',
        title: 't',
      });
      await publishFact(
        tx,
        aPublishWorld(workspaceId, clock, [NOTES, WIKI]).context,
        NOTE_CREATED,
        {
          noteId: 'b',
          title: 't',
        },
      );
      const rows = await rowsOf(tx, workspaceId);
      expect(rows.map((row) => row.payload)).toEqual([{ noteId: 'b', title: 't' }]);
      // A fact that is not dropped waits a day at most for a consumer, as a notice later than that is wrong.
      expect(rows[0]?.expires_at).toEqual(new Date(NOW.getTime() + DAY_MS));
    }, cloned.db);
  });
});

describe('integration: what a publish refuses, ending the publisher’s transaction', () => {
  const publish = async (payload: unknown, producer = 'notes'): Promise<unknown> => {
    let thrown: unknown;
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock, [NOTES, WIKI], producer);
      try {
        // @ts-expect-error the payload is unchecked on purpose: refusing the wrong ones is the test
        await publishFact(tx, context, NOTE_CREATED, payload);
      } catch (error) {
        thrown = error;
      }
      // What is refused leaves nothing; what is accepted is a row, which is the other half of every boundary.
      expect(await rowsOf(tx, workspaceId)).toHaveLength(thrown === undefined ? 1 : 0);
    }, cloned.db);
    return thrown;
  };

  test('a payload that does not fit its declaration, without saying what was in it', async () => {
    const thrown = await publish({ noteId: 'n1', title: 42, secretWord: 'hunter2' });
    expect(thrown).toBeInstanceOf(FactPublishError);
    expect(String(thrown)).toContain('does not fit its declaration');
    expect(String(thrown)).not.toContain('hunter2');
    expect(await publish({ noteId: 'n1' })).toBeInstanceOf(FactPublishError);
  });

  test('a payload one byte past eight KiB, and takes one at exactly eight', async () => {
    const compact = (title: string): number =>
      new TextEncoder().encode(JSON.stringify({ noteId: 'n', title })).length;
    const room = OUTBOX_PAYLOAD_BYTES_MAX - compact('');
    expect(await publish({ noteId: 'n', title: 'x'.repeat(room + 1) })).toBeInstanceOf(
      FactPublishError,
    );
    expect(await publish({ noteId: 'n', title: 'x'.repeat(room) })).toBeUndefined();
  });

  test('a payload of Unicode that is longer in bytes than in characters', async () => {
    const room =
      OUTBOX_PAYLOAD_BYTES_MAX - new TextEncoder().encode('{"noteId":"n","title":""}').length;
    expect(await publish({ noteId: 'n', title: 'ş'.repeat(room / 2 + 1) })).toBeInstanceOf(
      FactPublishError,
    );
    expect(await publish({ noteId: 'n', title: 'ş'.repeat(room / 2) })).toBeUndefined();
  });

  test('a module that does not own the fact', async () => {
    const thrown = await publish({ noteId: 'n', title: 't' }, 'wiki');
    expect(String(thrown)).toContain('"wiki" is not its publisher');
  });

  test('a module that lists a fact it does not own, and one that owns a fact it does not list', async () => {
    const claims = { ...WIKI, publishes: ['notes.created'] };
    const unlisted = { ...NOTES, publishes: [] };
    for (const [carried, producer, reason] of [
      [[NOTES, claims], 'wiki', '"wiki" is not its publisher'],
      [[unlisted, WIKI], 'notes', '"notes" is not its publisher'],
    ] as const) {
      await withRollback(async (tx) => {
        const workspaceId = await aWorkspaceRow(tx);
        const { context } = aPublishWorld(workspaceId, clock);
        const routing = factRoutingOf(carried, carried);
        const refused = await refusalOf(
          publishFact(tx, { ...context, producer, routing }, NOTE_CREATED, {
            noteId: 'n',
            title: 't',
          }),
        );
        expect(String(refused)).toContain(reason);
        expect(await rowsOf(tx, workspaceId)).toEqual([]);
      }, cloned.db);
    }
  });

  test('a module speaking for another in its own request', async () => {
    const thrown = await withinRequest(
      { requestId: 'r', startedAt: 0, module: 'wiki' },
      async () => await publish({ noteId: 'n', title: 't' }),
    );
    expect(String(thrown)).toContain('in a request of "wiki"');
  });
});

describe('integration: a deleted workspace’s facts', () => {
  test('are taken in batches, and a neighbour’s are not', async () => {
    await withRollback(async (tx) => {
      const mine = await aWorkspaceRow(tx);
      const theirs = await aWorkspaceRow(tx);
      for (const workspaceId of [mine, mine, mine, theirs]) {
        await publishFact(tx, aPublishWorld(workspaceId, clock).context, NOTE_PINNED, {
          noteId: 'n',
        });
      }
      expect(await purgeWorkspaceFacts(tx, mine, 2)).toBe(2);
      expect(await purgeWorkspaceFacts(tx, mine, 2)).toBe(1);
      expect(await purgeWorkspaceFacts(tx, mine, 2)).toBe(0);
      expect(await rowsOf(tx, mine)).toEqual([]);
      expect(await rowsOf(tx, theirs)).toHaveLength(1);
    }, cloned.db);
  });
});
