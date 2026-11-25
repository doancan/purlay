/**
 * The ledger of deliveries (#1305): one line for each `(fact, consumer)` delivered, written in the transaction that marks the row
 * and only where the operator turned it on, never a payload; read by workspace; swept past its retention; and the command that
 * reads it. Real PostgreSQL, through the drain's own entry point.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { aMovableClock, aRecordingLogger, NOW } from '../testing/doubles';
import { aPublishWorld, aWorkspaceRow, NOTE_CREATED } from '../testing/facts';
import { DAY_MS } from './clock';
import type { FactConsumer } from './fact-consumers';
import { drainOnce, type FactHandling, type Handled } from './outbox-drain';
import { LEDGER_READ_MAX, readLedger, sweepLedger } from './outbox-ledger';
import { runLedger } from './outbox-ledger-command';
import { publishFact } from './outbox';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
  await sql`delete from outbox_ledger`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const wiki: Handled = { consumer: 'wiki', type: 'notes.created', shape: 1 };
const handlers = (handle: FactConsumer): readonly (Handled & FactHandling)[] => [
  { ...wiki, declaration: NOTE_CREATED, handle },
];
const delivers: FactConsumer = () => Promise.resolve('done');
const skips: FactConsumer = () => Promise.resolve('skipped');

const publish = async (workspaceId: string, clock = aMovableClock(NOW)): Promise<void> => {
  await cloned.db.transaction().execute(async (tx) => {
    await publishFact(tx, aPublishWorld(workspaceId, clock).context, NOTE_CREATED, {
      noteId: 'secret-note',
      title: 'a title that must never reach the ledger',
    });
  });
};

const drain = async (
  handle: FactConsumer,
  ledger: boolean | undefined,
  clock = aMovableClock(NOW),
): Promise<void> => {
  await drainOnce(cloned.db, {
    handlers: handlers(handle),
    batch: 10,
    clock,
    log: aRecordingLogger().log,
    ...(ledger === undefined
      ? {}
      : {
          counters: {
            delivered: { inc: (): void => undefined },
            failures: { inc: (): void => undefined },
            ledger,
          },
        }),
  });
};

const lines = async (workspaceId: string): Promise<readonly string[]> =>
  (
    await cloned.db
      .selectFrom('outbox_ledger')
      .select(['consumer', 'type', 'producer'])
      .where('workspace_id', '=', workspaceId)
      .execute()
  ).map((row) => `${row.producer}>${row.consumer} ${row.type}`);

describe('integration: what a delivery writes to the ledger', () => {
  test('one line for a fact delivered, in the transaction that marks it: ids, the type, the producer and the time', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(delivers, true);
    expect(await lines(workspaceId)).toEqual(['notes>wiki notes.created']);
    const row = await cloned.db
      .selectFrom('outbox_ledger')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    const marked = await cloned.db
      .selectFrom('outbox')
      .select(['fact_id', 'finished_at'])
      .where('workspace_id', '=', workspaceId)
      .where('consumer', '=', 'wiki')
      .executeTakeFirstOrThrow();
    expect(row.fact_id).toBe(marked.fact_id);
    expect(String(row.delivered_at)).toBe(String(marked.finished_at));
  });

  test('holds no payload and no column that could: its columns are the six it is made of', async () => {
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'outbox_ledger' order by column_name`.execute(
      cloned.db,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'consumer',
      'delivered_at',
      'fact_id',
      'producer',
      'type',
      'workspace_id',
    ]);
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(delivers, true);
    const text = JSON.stringify(
      await cloned.db
        .selectFrom('outbox_ledger')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .execute(),
    );
    expect(text).not.toContain('secret-note');
    expect(text).not.toContain('a title that must never reach the ledger');
  });

  test('none where the ledger is off, whether the setting is false or the worker was never told', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(delivers, false);
    expect(await lines(workspaceId)).toEqual([]);
    await sql`update outbox set state = 'pending', finished_at = null`.execute(cloned.db);
    await drain(delivers, undefined);
    expect(await lines(workspaceId)).toEqual([]);
  });

  test('none for a fact skipped, which was not delivered', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(skips, true);
    expect(await lines(workspaceId)).toEqual([]);
  });

  test('none for a fact whose handler failed, and the row waits for its backoff: a line is never written ahead of its delivery', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(() => Promise.reject(new Error('the consumer is down')), true);
    expect(await lines(workspaceId)).toEqual([]);
    const row = await cloned.db
      .selectFrom('outbox')
      .select('state')
      .where('workspace_id', '=', workspaceId)
      .where('consumer', '=', 'wiki')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('pending');
  });

  test('a fact delivered once more, after it was requeued, is still one line', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publish(workspaceId);
    await drain(delivers, true);
    await sql`update outbox set state = 'pending', finished_at = null, next_attempt_at = ${NOW}`.execute(
      cloned.db,
    );
    await drain(delivers, true);
    expect(await lines(workspaceId)).toEqual(['notes>wiki notes.created']);
    // And the second delivery was made, not failed on the ledger's own key and left to be tried again.
    const row = await cloned.db
      .selectFrom('outbox')
      .select('state')
      .where('workspace_id', '=', workspaceId)
      .where('consumer', '=', 'wiki')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('delivered');
  });
});

describe('integration: reading the ledger', () => {
  const record = async (
    workspaceId: string,
    n: number,
    over: { consumer?: string; type?: string; at?: Date } = {},
  ): Promise<string> => {
    const factId = `0199155c-${(0x9000 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`;
    await cloned.db
      .insertInto('outbox_ledger')
      .values({
        fact_id: factId,
        consumer: over.consumer ?? 'wiki',
        workspace_id: workspaceId,
        type: over.type ?? 'notes.created',
        producer: 'notes',
        delivered_at: over.at ?? new Date(NOW.getTime() + n * 1000),
      })
      .execute();
    return factId;
  };

  test('a workspace’s own deliveries, newest first, and never another workspace’s', async () => {
    const mine = await aWorkspaceRow(cloned.db);
    const theirs = await aWorkspaceRow(cloned.db);
    const first = await record(mine, 1);
    const second = await record(mine, 2);
    await record(theirs, 3);
    expect((await readLedger(cloned.db, mine, {})).map((entry) => entry.factId)).toEqual([
      second,
      first,
    ]);
    expect(await readLedger(cloned.db, theirs, { factId: first })).toEqual([]);
  });

  test('narrowed by fact and by consumer, and capped: asking for more than the most gets the most', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const one = await record(workspaceId, 1, { consumer: 'wiki' });
    await record(workspaceId, 2, { consumer: 'shelf' });
    expect(await readLedger(cloned.db, workspaceId, { factId: one })).toHaveLength(1);
    expect(
      (await readLedger(cloned.db, workspaceId, { consumer: 'shelf' })).map((e) => e.consumer),
    ).toEqual(['shelf']);
    await sql`
      insert into outbox_ledger (fact_id, consumer, workspace_id, type, producer, delivered_at)
      select gen_random_uuid(), 'wiki', ${workspaceId}, 'notes.created', 'notes', ${NOW}
      from generate_series(1, ${LEDGER_READ_MAX + 20})`.execute(cloned.db);
    expect(await readLedger(cloned.db, workspaceId, { limit: 100_000 })).toHaveLength(
      LEDGER_READ_MAX,
    );
    expect(await readLedger(cloned.db, workspaceId, { limit: 3 })).toHaveLength(3);
  });

  test('the command prints ids, the type and the time, and refuses what it cannot make', async () => {
    const slug = (
      await cloned.db
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', await aWorkspaceRow(cloned.db))
        .executeTakeFirstOrThrow()
    ).slug;
    const id = await cloned.db
      .selectFrom('workspaces')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirstOrThrow();
    const factId = await record(id.id, 5);
    const shown = await runLedger([slug], { database: cloned.db, enabled: true });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(factId);
    expect(shown.out).toContain('wiki  notes.created');
    expect(shown.out).toContain('(from notes)');
    expect(shown.out).not.toContain('the ledger is off');
    const off = await runLedger([slug, '--fact', factId], { database: cloned.db, enabled: false });
    expect(off.out).toContain('the ledger is off');
    expect(off.out).toContain(factId);
    const none = await runLedger([slug, '--consumer', 'shelf'], {
      database: cloned.db,
      enabled: true,
    });
    expect(none).toMatchObject({ code: 0, out: 'no delivery recorded\n' });
    for (const argv of [
      [],
      ['--fact', factId],
      [slug, '--fact', 'not-an-id'],
      [slug, '--consumer', 'Not A Module'],
      [slug, '--limit', '0'],
      [slug, '--limit', '201'],
      [slug, '--limit', 'many'],
      [slug, '--limit'],
      [slug, '--unknown', 'x'],
      [slug, '--limit', '5', '--limit', '6'],
      ['no-such-workspace'],
    ]) {
      const refused = await runLedger(argv, { database: cloned.db, enabled: true });
      expect(refused.code, argv.join(' ')).toBe(2);
      expect(refused.err, argv.join(' ')).not.toBe('');
    }
  });
});

describe('integration: the ledger’s retention', () => {
  const lineAt = async (workspaceId: string, daysAgo: number, now: Date): Promise<void> => {
    await cloned.db
      .insertInto('outbox_ledger')
      .values({
        fact_id: crypto.randomUUID(),
        consumer: 'wiki',
        workspace_id: workspaceId,
        type: 'notes.created',
        producer: 'notes',
        delivered_at: new Date(now.getTime() - daysAgo * DAY_MS),
      })
      .execute();
  };

  test('takes what is older than the days it is kept, to the millisecond, and keeps the rest', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const clock = aMovableClock(NOW);
    await lineAt(workspaceId, 31, NOW);
    await lineAt(workspaceId, 30, NOW);
    await lineAt(workspaceId, 1, NOW);
    expect(await sweepLedger({ database: cloned.db, clock, keptDays: 30 })).toBe(1);
    expect(await readLedger(cloned.db, workspaceId, {})).toHaveLength(2);
    // A line exactly at the boundary is not past it.
    expect(await sweepLedger({ database: cloned.db, clock, keptDays: 30 })).toBe(0);
  });

  test('takes nothing where no retention is set: turning the ledger off keeps what is there', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await lineAt(workspaceId, 4000, NOW);
    expect(
      await sweepLedger({ database: cloned.db, clock: aMovableClock(NOW), keptDays: undefined }),
    ).toBe(0);
    expect(await readLedger(cloned.db, workspaceId, {})).toHaveLength(1);
  });

  test('a long backlog is a loop of batches, not one statement', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await sql`
      insert into outbox_ledger (fact_id, consumer, workspace_id, type, producer, delivered_at)
      select gen_random_uuid(), 'wiki', ${workspaceId}, 'notes.created', 'notes', ${new Date(NOW.getTime() - 40 * DAY_MS)}
      from generate_series(1, 5_010)`.execute(cloned.db);
    expect(
      await sweepLedger({ database: cloned.db, clock: aMovableClock(NOW), keptDays: 30 }),
    ).toBe(5_010);
    const left = await cloned.db
      .selectFrom('outbox_ledger')
      .select('fact_id')
      .where('workspace_id', '=', workspaceId)
      .execute();
    expect(left).toEqual([]);
  }, 60_000);
});
