/**
 * Taking a fact out of the outbox and running it (D-288, D-283 §2), with real connections: two drainers on two pools never run
 * a fact twice, a fact that fails or kills its node reaches the ceiling, and a handler's effect and the delivery mark are one commit.
 * The clock is the test's, so a backoff is a thing the test passes and not a thing it waits for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  createDatabase,
  sql,
  type ClonedDatabase,
  type DatabasePool,
  type Executor,
  type Outbox,
  type Selectable,
} from '@purlay/db';
import { defineFact, readsEarlierShape, type FactDeclaration } from '@purlay/types';
import { aMovableClock, aRecordingLogger, NOW } from '../testing/doubles';
import {
  aGrant,
  aPublishWorld,
  aWorkspaceRow,
  NOTE_CREATED,
  NOTE_CREATED_V2,
  NOTE_FOLDER_DEFAULT,
  NOTE_PINNED,
  theGrants,
} from '../testing/facts';
import { currentRequest, withinRequest } from './logging';
import { renderMetrics, serverMetrics } from './metrics';
import { readExposition, sampleOf } from '../testing/exposition';
import type { FactConsumer } from './fact-consumers';
import {
  backoffMs,
  claimDue,
  deliver,
  drainOnce,
  OUTBOX_ATTEMPTS_MAX,
  type ClaimedFact,
  type FactHandling,
  type Handled,
  type OutboxCounters,
} from './outbox-drain';
import { publishFact } from './outbox';

let cloned: ClonedDatabase;
let second: DatabasePool;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  second = createDatabase({
    connectionString: cloned.connectionString,
    poolSize: 4,
  });
  await sql`create table handled (fact_id uuid not null, workspace_id uuid not null)`.execute(
    cloned.db,
  );
}, CLONE_HOOK_MS);
// Every test starts with an empty table: a consumer's rows are the whole table's, and one test's leftovers are another's batch.
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
});
afterAll(async () => {
  await second.destroy();
  await cloned.drop();
}, DROP_HOOK_MS);

const declaration = NOTE_CREATED;
const wiki: Handled[] = [{ consumer: 'wiki', type: 'notes.created', shape: 1 }];
const BATCH = 5;

const publish = async (
  workspaceId: string,
  clock = aMovableClock(NOW),
  noteId = 'n',
  title = 't',
): Promise<void> => {
  await cloned.db.transaction().execute(async (tx) => {
    await publishFact(tx, aPublishWorld(workspaceId, clock).context, NOTE_CREATED, {
      noteId,
      title,
    });
  });
};

const rowOf = async (workspaceId: string): Promise<Selectable<Outbox>[]> =>
  await cloned.db
    .selectFrom('outbox')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('consumer', '=', 'wiki')
    .orderBy('id')
    .execute();

/** A handler that records the fact it ran for, in the transaction it was given. */
const recording: FactConsumer = async (fact, transaction) => {
  await sql`insert into handled (fact_id, workspace_id) values (${fact.factId}, ${fact.workspaceId})`.execute(
    transaction,
  );
  return 'done';
};

/** What a promise was refused with, or `undefined` when it was not: the way a refusal is asserted on here. */
const refusalOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const deliverAll = async (
  database: Executor,
  claimed: readonly ClaimedFact[],
  handle: FactConsumer,
  clock = aMovableClock(NOW),
  delivering: FactDeclaration = declaration,
): Promise<string[]> => {
  const { log } = aRecordingLogger();
  const outcomes: string[] = [];
  for (const one of claimed) {
    outcomes.push(
      await deliver(database, one, { declaration: delivering, handle }, { clock, log }),
    );
  }
  return outcomes;
};

describe('integration: the wait between tries', () => {
  test('doubles from five seconds to an hour, within a fifth either way', () => {
    const middle = (): number => 0.5;
    expect([1, 2, 3, 4].map((attempt) => backoffMs(attempt, middle))).toEqual([
      5000, 10000, 20000, 40000,
    ]);
    expect(backoffMs(30, middle)).toBe(3_600_000);
    expect(backoffMs(1, () => 0)).toBe(4000);
    expect(backoffMs(1, () => 1)).toBe(6000);
  });
});

describe('integration: one node claims a fact and delivers it', () => {
  test('claims what is due, counts the attempt and leases the row by the backoff, then marks it delivered with the handler’s effect', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);

    const { claimed, exhausted } = await claimDue(cloned.db, {
      handles: wiki,
      batch: BATCH,
      clock,
    });
    expect(exhausted).toEqual([]);
    expect(claimed.map((one) => [one.type, one.consumer])).toEqual([['notes.created', 'wiki']]);
    const leased = (await rowOf(workspaceId))[0];
    expect(leased?.attempts).toBe(1);
    expect(leased?.state).toBe('pending');
    const wait = (leased?.next_attempt_at.getTime() ?? 0) - NOW.getTime();
    expect(wait).toBeGreaterThanOrEqual(4000);
    expect(wait).toBeLessThanOrEqual(6000);
    // Leased: nobody else is given it before the backoff has passed.
    expect((await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed).toEqual([]);

    expect(await deliverAll(cloned.db, claimed, recording, clock)).toEqual(['delivered']);
    const done = (await rowOf(workspaceId))[0];
    expect(done).toMatchObject({ state: 'delivered', last_error: null, finished_at: NOW });
    const effects = await sql<{
      workspace_id: string;
      fact_id: string;
    }>`select workspace_id, fact_id from handled where workspace_id = ${workspaceId}`.execute(
      cloned.db,
    );
    // The handler was given the workspace of the row, and the fact id that is the key of an effect outside the database.
    expect(effects.rows).toEqual([{ workspace_id: workspaceId, fact_id: done?.fact_id ?? '' }]);
    // Delivered is delivered: neither a claim nor a second delivery of the same row does it again.
    clock.advance(86_400_000);
    expect((await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed).toEqual([]);
    expect(await deliverAll(cloned.db, claimed, recording, clock)).toEqual(['gone']);
  });

  test('takes only the consumers it is asked for, and at most a batch, oldest due first', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    for (let n = 0; n < 4; n += 1) {
      await publish(workspaceId, clock, `n${String(n)}`);
      clock.advance(1000);
    }
    const none = await claimDue(cloned.db, {
      handles: [{ consumer: 'someone-else', type: 'notes.created', shape: 1 }],
      batch: BATCH,
      clock,
    });
    expect(none.claimed).toEqual([]);
    expect((await claimDue(cloned.db, { handles: [], batch: BATCH, clock })).claimed).toEqual([]);
    const first = await claimDue(cloned.db, { handles: wiki, batch: 3, clock });
    expect(first.claimed).toHaveLength(3);
    const rows = await rowOf(workspaceId);
    expect(rows.map((row) => row.attempts).sort()).toEqual([0, 1, 1, 1]);
    const claimedIds = first.claimed.map((one) => one.id);
    const notesOf = (taken: boolean): string[] =>
      rows
        .filter((row) => claimedIds.includes(row.id) === taken)
        .map((row) => (Value.Check(NOTE_CREATED.schema, row.payload) ? row.payload.noteId : ''))
        .sort();
    // Oldest due first: the three it took are the first three published.
    expect(notesOf(true)).toEqual(['n0', 'n1', 'n2']);
    expect(notesOf(false)).toEqual(['n3']);
  });
});

describe('integration: two nodes drain one table', () => {
  test('never run a fact twice, whichever way their claims and deliveries interleave', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    const FACTS = 40;
    for (let n = 0; n < FACTS; n += 1) await publish(workspaceId, clock, `n${String(n)}`);

    const slowRecording: FactConsumer = async (fact, transaction) => {
      await recording(fact, transaction);
      await sql`select pg_sleep(0.002)`.execute(transaction);
      return 'done';
    };
    const drain = async (database: Executor): Promise<number> => {
      let delivered = 0;
      for (;;) {
        const { claimed } = await claimDue(database, { handles: wiki, batch: BATCH, clock });
        if (claimed.length === 0) return delivered;
        const outcomes = await deliverAll(database, claimed, slowRecording, clock);
        delivered += outcomes.filter((outcome) => outcome === 'delivered').length;
      }
    };
    const [a, b] = await Promise.all([drain(cloned.db), drain(second)]);
    // A delivery leaves a row that another node's claim holds for an instant, though it is its own; the lease brings it back, so
    // what is asked is that every fact is delivered once, now or at the next backoff, and none twice.
    clock.advance(3_700_000);
    const later = await drain(cloned.db);

    expect(a + b + later).toBe(FACTS);
    const effects = await sql<{
      fact_id: string;
      n: string;
    }>`select fact_id, count(*) as n from handled where workspace_id = ${workspaceId} group by fact_id`.execute(
      cloned.db,
    );
    expect(effects.rows).toHaveLength(FACTS);
    expect(effects.rows.every((row) => row.n === '1')).toBe(true);
    expect(
      (await rowOf(workspaceId)).every(
        (row) => row.state === 'delivered' && row.attempts >= 1 && row.attempts <= 2,
      ),
    ).toBe(true);
  });

  test('pass over a row the other holds, and neither waits for it', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    for (const noteId of ['held', 'free-1', 'free-2']) {
      await publish(workspaceId, clock, noteId);
      clock.advance(1000);
    }
    const [heldRow] = await rowOf(workspaceId);
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another node, in the middle of its claim: it has the oldest row locked and has not committed.
    const holder = cloned.db.transaction().execute(async (tx) => {
      await sql`select 1 from outbox where id = ${heldRow?.id ?? ''} for update`.execute(tx);
      locked();
      await holding;
    });
    await lockTaken;
    try {
      const outcome = await Promise.race([
        claimDue(second, { handles: wiki, batch: BATCH, clock }),
        Bun.sleep(3000).then(() => 'waited' as const),
      ]);
      expect(outcome).not.toBe('waited');
      const { claimed } = outcome as Awaited<ReturnType<typeof claimDue>>;
      expect(claimed.map((one) => one.id)).not.toContain(heldRow?.id);
      expect(claimed).toHaveLength(2);

      const delivered = await Promise.race([
        deliverAll(
          second,
          [
            {
              id: heldRow?.id ?? '',
              factId: heldRow?.fact_id ?? '',
              type: 'notes.created',
              consumer: 'wiki',
            },
          ],
          recording,
          clock,
        ),
        Bun.sleep(3000).then(() => 'waited' as const),
      ]);
      expect(delivered).toEqual(['gone']);
    } finally {
      release();
      await holder;
    }
  });
});

describe('integration: a fact that does not get delivered', () => {
  test('reaches the ceiling by its attempts and is dead, with the class of its error and not its words', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock, 'poison', 'hunter2-the-secret-title');
    const throwing: FactConsumer = async (fact, transaction) => {
      await recording(fact, transaction);
      throw new Error(`could not post "${JSON.stringify(fact.payload)}"`);
    };
    const outcomes: string[] = [];
    for (let round = 0; round < OUTBOX_ATTEMPTS_MAX + 2; round += 1) {
      const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
      outcomes.push(...(await deliverAll(cloned.db, claimed, throwing, clock)));
      clock.advance(3_700_000);
    }
    expect(outcomes).toEqual([...Array<string>(OUTBOX_ATTEMPTS_MAX - 1).fill('failed'), 'dead']);
    const [row] = await rowOf(workspaceId);
    expect(row).toMatchObject({
      state: 'dead',
      attempts: OUTBOX_ATTEMPTS_MAX,
      last_error: 'Error',
    });
    expect(row?.finished_at).not.toBeNull();
    // Each try's effect went with its savepoint.
    const effects = await sql`select 1 from handled where workspace_id = ${workspaceId}`.execute(
      cloned.db,
    );
    expect(effects.rows).toHaveLength(0);
  });

  test('is tried again after its backoff and not before, and is delivered when a try goes through', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    const flaky: FactConsumer = async (fact, transaction) => {
      const tries = (await rowOf(workspaceId))[0]?.attempts ?? 0;
      if (tries < 3) throw new Error('not yet');
      return await recording(fact, transaction);
    };
    for (const expected of ['failed', 'failed', 'delivered']) {
      clock.advance(3_700_000);
      const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
      expect(await deliverAll(cloned.db, claimed, flaky, clock)).toEqual([expected]);
      expect((await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed).toEqual(
        [],
      );
    }
    expect((await rowOf(workspaceId))[0]).toMatchObject({ state: 'delivered', attempts: 3 });
  });

  test('is claimed again after its node died between the claim and the delivery', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    expect(
      (await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed,
    ).toHaveLength(1);
    // The node is gone: nothing delivers it, and nothing else may before its lease runs out.
    expect((await claimDue(second, { handles: wiki, batch: BATCH, clock })).claimed).toEqual([]);
    clock.advance(7000);
    const again = await claimDue(second, { handles: wiki, batch: BATCH, clock });
    expect(again.claimed).toHaveLength(1);
    expect(await deliverAll(second, again.claimed, recording, clock)).toEqual(['delivered']);
    expect((await rowOf(workspaceId))[0]).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  test('is dead once it has taken its node down every time, without the handler being asked again', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    for (let round = 0; round < OUTBOX_ATTEMPTS_MAX; round += 1) {
      expect(
        (await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed,
      ).toHaveLength(1);
      clock.advance(3_700_000);
    }
    const last = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    expect(last.claimed).toEqual([]);
    expect(last.exhausted).toHaveLength(1);
    expect((await rowOf(workspaceId))[0]).toMatchObject({
      state: 'dead',
      attempts: OUTBOX_ATTEMPTS_MAX,
      last_error: 'AttemptsExhausted',
    });
    expect((await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).exhausted).toEqual(
      [],
    );
  });
});

describe('integration: the handler’s effect and the mark are one commit', () => {
  test('a node that fails after the handler and before the mark leaves no effect, and the row is delivered once, later', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    // The fault is at the clock, which the mark is stamped with: the handler has run and its effect is written, uncommitted.
    let ran = false;
    const failing = {
      now: (): Date => {
        if (ran) throw new Error('the node fails before it commits');
        return NOW;
      },
    };
    const one = claimed[0];
    if (one === undefined) throw new Error('nothing was claimed');
    const handle: FactConsumer = async (fact, transaction) => {
      await recording(fact, transaction);
      ran = true;
      return 'done';
    };
    const { log } = aRecordingLogger();
    expect(
      String(
        await refusalOf(deliver(second, one, { declaration, handle }, { clock: failing, log })),
      ),
    ).toContain('before it commits');
    expect(
      (await sql`select 1 from handled where workspace_id = ${workspaceId}`.execute(cloned.db))
        .rows,
    ).toHaveLength(0);
    expect((await rowOf(workspaceId))[0]).toMatchObject({ state: 'pending', attempts: 1 });

    clock.advance(7000);
    const again = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    expect(await deliverAll(cloned.db, again.claimed, recording, clock)).toEqual(['delivered']);
    expect(
      (await sql`select 1 from handled where workspace_id = ${workspaceId}`.execute(cloned.db))
        .rows,
    ).toHaveLength(1);
  });

  test('a handler that skips the fact ends it as skipped, with what it did kept', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    const skipping: FactConsumer = () => Promise.resolve('skipped');
    expect(await deliverAll(cloned.db, claimed, skipping, clock)).toEqual(['skipped']);
    expect((await rowOf(workspaceId))[0]).toMatchObject({ state: 'skipped' });
  });

  test('a payload that no longer fits what the consumer expects is dead at once, and the handler is not asked', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    // The consumer is on a newer version of the declaration than the publisher was.
    const newer = defineFact({
      type: 'notes.created',
      owner: 'notes',
      absent: 'drop',
      schema: Type.Object({ noteId: Type.String(), title: Type.String(), colour: Type.String() }),
    });
    let asked = false;
    const { log, lines } = aRecordingLogger();
    const one = claimed[0];
    if (one === undefined) throw new Error('nothing was claimed');
    const outcome = await deliver(
      cloned.db,
      one,
      {
        declaration: newer,
        handle: () => {
          asked = true;
          return Promise.resolve('done');
        },
      },
      { clock, log },
    );
    expect(outcome).toBe('dead');
    expect(asked).toBe(false);
    expect((await rowOf(workspaceId))[0]).toMatchObject({
      state: 'dead',
      last_error: 'PayloadRefused',
    });
    const said = lines.find((line) => line['level'] === 'error');
    expect(said).toMatchObject({ fact: 'notes.created', consumer: 'wiki' });
    expect(JSON.stringify(lines)).not.toContain('"title":"t"');
  });
});

describe('integration: two nodes on two versions share one table (a rolling deploy)', () => {
  const older: Handled[] = [{ consumer: 'wiki', type: 'notes.created', shape: 1 }];
  const newer: Handled[] = [
    { consumer: 'wiki', type: 'notes.created', shape: 2 },
    { consumer: 'wiki', type: 'notes.pinned', shape: 1 },
  ];

  const publishNewer = async (workspaceId: string, clock = aMovableClock(NOW)): Promise<void> => {
    await cloned.db.transaction().execute(async (tx) => {
      const { context } = aPublishWorld(workspaceId, clock);
      await publishFact(tx, context, NOTE_CREATED_V2, { noteId: 'v2', title: 't', folder: 'f' });
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'p' });
    });
  };

  test('the older node leaves the type it has no handler for and the shape it does not know, untouched and with no try spent', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publishNewer(workspaceId, clock);
    await publish(workspaceId, clock, 'v1');
    const before = await rowOf(workspaceId);
    expect(before).toHaveLength(3);

    const { claimed, exhausted } = await claimDue(cloned.db, {
      handles: older,
      batch: BATCH,
      clock,
    });
    expect(exhausted).toEqual([]);
    expect(claimed).toHaveLength(1);
    const after = await rowOf(workspaceId);
    const untouched = after.filter((row) => row.id !== claimed[0]?.id);
    expect(untouched).toHaveLength(2);
    expect(untouched.every((row) => row.attempts === 0 && row.state === 'pending')).toBe(true);
    expect(untouched.map((row) => row.next_attempt_at)).toEqual(
      before.filter((row) => row.id !== claimed[0]?.id).map((row) => row.next_attempt_at),
    );
    expect(claimed[0]?.id).toBe(
      before.find((row) => row.shape === 1 && row.type === 'notes.created')?.id,
    );
  });

  test('the newer node takes what the older left, and delivers it by the shape it wrote', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publishNewer(workspaceId, clock);
    await claimDue(cloned.db, { handles: older, batch: BATCH, clock });
    const { claimed } = await claimDue(second, { handles: newer, batch: BATCH, clock });
    expect(claimed.map((one) => one.type).sort()).toEqual(['notes.created', 'notes.pinned']);
    const seen: string[] = [];
    const { log } = aRecordingLogger();
    for (const one of claimed) {
      const declaration = one.type === 'notes.pinned' ? NOTE_PINNED : NOTE_CREATED_V2;
      const handle: FactConsumer = (fact) => {
        seen.push(fact.type);
        return Promise.resolve('done');
      };
      expect(await deliver(second, one, { declaration, handle }, { clock, log })).toBe('delivered');
    }
    expect(seen.sort()).toEqual(['notes.created', 'notes.pinned']);
  });

  test('a shape the node knows that does not fit is dead, the one thing a rolling deploy does not excuse', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    // Written as the first shape, but the node's own declaration of the first shape wants more: a contract broken, not a newer one.
    const broken = defineFact({
      type: 'notes.created',
      owner: 'notes',
      absent: 'drop',
      schema: Type.Object({ noteId: Type.String(), title: Type.String(), colour: Type.String() }),
    });
    const { claimed } = await claimDue(cloned.db, { handles: older, batch: BATCH, clock });
    const { log } = aRecordingLogger();
    const one = claimed[0];
    if (one === undefined) throw new Error('nothing was claimed');
    const handle: FactConsumer = () => Promise.resolve('done');
    expect(await deliver(cloned.db, one, { declaration: broken, handle }, { clock, log })).toBe(
      'dead',
    );
  });
  test('the newer node reads a row the older one published in the shape before, and hands the handler the payload upgraded to its own', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock, 'old-shape', 'kept');
    const { claimed } = await claimDue(second, { handles: newer, batch: BATCH, clock });
    expect(claimed).toHaveLength(1);
    const payloads: unknown[] = [];
    const handle: FactConsumer = (fact) => {
      payloads.push(fact.payload);
      return Promise.resolve('done');
    };
    expect(await deliverAll(second, claimed, handle, clock, NOTE_CREATED_V2)).toEqual([
      'delivered',
    ]);
    expect(payloads).toEqual([{ noteId: 'old-shape', title: 'kept', folder: NOTE_FOLDER_DEFAULT }]);
    expect((await rowOf(workspaceId))[0]).toMatchObject({ state: 'delivered', shape: 1 });
  });

  test('a row of an earlier shape that no reader describes, one that does not fit its own shape and an upgrade that breaks are dead, and the handler is not asked', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    const withReaders = (
      reads: NonNullable<typeof NOTE_CREATED_V2.reads>,
    ): typeof NOTE_CREATED_V2 => defineFact({ ...NOTE_CREATED_V2, reads });
    const unreadable = withReaders({});
    const wrongOutput = withReaders({ 1: readsEarlierShape(NOTE_CREATED.schema, (note) => note) });
    const throwing = withReaders({
      1: readsEarlierShape(NOTE_CREATED.schema, () => {
        throw new Error('cannot upgrade');
      }),
    });
    const strict = withReaders({
      1: readsEarlierShape(
        Type.Object({ noteId: Type.String(), colour: Type.String() }),
        (note) => ({
          ...note,
          title: '',
          folder: 'f',
        }),
      ),
    });
    for (const declaration of [unreadable, wrongOutput, throwing, strict]) {
      await publish(workspaceId, clock);
      const { claimed } = await claimDue(second, { handles: newer, batch: BATCH, clock });
      let asked = false;
      const handle: FactConsumer = () => {
        asked = true;
        return Promise.resolve('done');
      };
      expect(await deliverAll(second, claimed, handle, clock, declaration)).toEqual(['dead']);
      expect(asked).toBe(false);
      await sql`delete from outbox`.execute(cloned.db);
    }
  });
});

describe('integration: what a claim leaves', () => {
  test('a row of a workspace that is not granted the consumer stays as it was, and the others are taken', async () => {
    const clock = aMovableClock(NOW);
    const barred = await aWorkspaceRow(cloned.db);
    const allowed = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, barred, 'wiki', 'off');
    await publish(barred, clock);
    await publish(allowed, clock);
    const { claimed } = await claimDue(cloned.db, {
      handles: wiki,
      batch: BATCH,
      clock,
      effective: theGrants(),
    });
    expect(claimed).toHaveLength(1);
    expect((await rowOf(barred))[0]).toMatchObject({ attempts: 0, state: 'pending' });
    expect((await rowOf(allowed))[0]).toMatchObject({ attempts: 1 });
    // Granted again, it is delivered: the fact waited and was not lost.
    await sql`delete from workspace_modules where workspace_id = ${barred}`.execute(cloned.db);
    const again = await claimDue(cloned.db, {
      handles: wiki,
      batch: BATCH,
      clock,
      effective: theGrants(),
    });
    expect(again.claimed.map((one) => one.type)).toEqual(['notes.created']);
    expect((await rowOf(barred))[0]).toMatchObject({ attempts: 1 });
  });

  test('a row past its expiry is not claimed', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    clock.advance(2 * 86_400_000);
    expect((await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock })).claimed).toEqual([]);
    expect((await rowOf(workspaceId))[0]).toMatchObject({ attempts: 0, state: 'pending' });
  });
});

describe('integration: the chain from a request to its delivery', () => {
  test('the delivery runs in the id of the request that published it, as the consumer, and says so on every line', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await withinRequest({ requestId: 'req-1234', startedAt: 0, module: 'notes' }, () =>
      publish(workspaceId, clock),
    );
    const { claimed } = await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
    const { log, lines } = aRecordingLogger();
    const seen: unknown[] = [];
    const handle: FactConsumer = (fact) => {
      seen.push([fact.correlationId, currentRequest()?.requestId, currentRequest()?.module]);
      return Promise.reject(new Error('boom'));
    };
    const one = claimed[0];
    if (one === undefined) throw new Error('nothing was claimed');
    expect(await deliver(cloned.db, one, { declaration, handle }, { clock, log })).toBe('failed');
    expect(seen).toEqual([['req-1234', 'req-1234', 'wiki']]);
    expect(lines.find((line) => line['level'] === 'warn')).toMatchObject({
      correlationId: 'req-1234',
      consumer: 'wiki',
      fact: 'notes.created',
    });
  });
});

describe('integration: what a drain counts', () => {
  const counted = (): {
    readonly counters: OutboxCounters;
    readonly read: (name: 'delivered' | 'failures') => number;
  } => {
    const metrics = serverMetrics(
      undefined,
      [],
      [],
      [],
      [{ module: 'wiki', fact: 'notes.created' }],
    );
    return {
      counters: { delivered: metrics.outboxDelivered, failures: metrics.outboxFailures },
      read: (name) =>
        sampleOf(
          readExposition(renderMetrics(metrics)),
          name === 'delivered' ? 'purlay_outbox_delivered_total' : 'purlay_outbox_failures_total',
          { module: 'wiki', fact: 'notes.created' },
        ) ?? Number.NaN,
    };
  };
  const handlers = (handle: FactConsumer): readonly (Handled & FactHandling)[] => [
    { ...wiki[0]!, declaration, handle },
  ];

  test('the facts it delivered and the deliveries that failed, by module and fact type', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock, 'ok');
    await publish(workspaceId, clock, 'bad');
    const handle: FactConsumer = (fact, transaction) =>
      (fact.payload as { noteId: string }).noteId === 'bad'
        ? Promise.reject(new Error('no'))
        : recording(fact, transaction);
    const { counters, read } = counted();
    const { log } = aRecordingLogger();
    const tally = await drainOnce(cloned.db, {
      handlers: handlers(handle),
      batch: BATCH,
      clock,
      log,
      counters,
    });
    expect(tally).toMatchObject({ delivered: 1, failed: 1, dead: 0 });
    expect([read('delivered'), read('failures')]).toEqual([1, 1]);
  });

  test('a fact that used every try as a failure, though its handler is not asked again', async () => {
    const clock = aMovableClock(NOW);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId, clock);
    for (let round = 0; round < OUTBOX_ATTEMPTS_MAX; round += 1) {
      await claimDue(cloned.db, { handles: wiki, batch: BATCH, clock });
      clock.advance(3_700_000);
    }
    const { counters, read } = counted();
    const { log } = aRecordingLogger();
    const tally = await drainOnce(cloned.db, {
      handlers: handlers(recording),
      batch: BATCH,
      clock,
      log,
      counters,
    });
    expect(tally.exhausted).toBe(1);
    expect([read('delivered'), read('failures')]).toEqual([0, 1]);
  });
});
