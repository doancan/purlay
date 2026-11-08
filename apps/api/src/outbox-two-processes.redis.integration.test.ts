/**
 * Two API processes of one cluster run the same consumer's worker against one table (D-288, D-281): each is the real entry point,
 * started as an operating system starts it, with memory of its own, a pool of its own and signals of its own, on one database
 * and one Redis. The facts are those of the fake `notes` and `wiki`, which a preload gives the build the processes run, since
 * no bundled module consumes a fact yet; every delivery writes a row naming the node, in the transaction that marks the fact
 * delivered, so a fact run twice is two rows.
 *
 * `outbox-two-nodes.integration.test.ts` holds the claim and the shapes in one process; this holds what only processes have: a
 * node that is killed without a word and leaves its claims to lapse, and one that is asked to leave and drains.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from './platform/clock';
import { publishFact } from './platform/outbox';
import { redisUrlForTests } from './testing/redis';
import {
  aClusterNamespace,
  eventually,
  killClusterNodes,
  preloadFile,
  startClusterNode,
  untilReady,
  type ClusterNode,
} from './testing/cluster-node';
import { aPublishWorld, aWorkspaceRow, NOTE_CREATED, NOTES, WIKI } from './testing/facts';

/**
 * A process boots (config, pool, Redis, the module set and migration check) in a couple of seconds on an idle machine; the budget
 * is for a runner running other jobs' tests beside this one.
 */
const BOOT_MS = 30_000;
/**
 * The first claim of a fact puts its next attempt out by `backoffMs(1)`, 5 seconds within 20% either way: the lease a node that
 * is killed leaves behind, which the survivor waits out, plus the drains that follow.
 */
const LEASE_MS = 6_000;
/** A node's worker runs every two seconds and takes twenty facts (`outbox-consumer.ts`). */
const DRAIN_MS = 2_000;
const BATCH = 20;
/** How long a delivery takes: a batch of twenty then lasts as long as the interval between two drains, so the nodes' drains overlap. */
const SLOW_MS = 100;

let cloned: ClonedDatabase;
const started: ClusterNode[] = [];

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`create table cluster_deliveries (fact_id uuid not null, node text not null)`.execute(
    cloned.db,
  );
}, CLONE_HOOK_MS);

/** Each test counts its own deliveries and its own facts. */
beforeEach(async () => {
  await sql`truncate cluster_deliveries`.execute(cloned.db);
  await cloned.db.deleteFrom('outbox').execute();
});

afterEach(async () => {
  await killClusterNodes(started.splice(0));
});

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const aNode = (label: string, redisPrefix: string, paceMs: number): ClusterNode => {
  const node = startClusterNode({
    databaseUrl: cloned.connectionString,
    redisUrl: redisUrlForTests(),
    redisPrefix,
    preloads: [preloadFile('node-with-wiki-preload.ts')],
    // Only the fake modules run: the database of a cell of the module matrix has no tables of the bundled ones.
    env: { MODULES: 'notes,wiki', NODE_LABEL: label, HANDLER_PACE_MS: String(paceMs) },
  });
  started.push(node);
  return node;
};

/** Publishes `count` facts for `wiki` in a workspace of their own, a transaction each, as a request that wrote one thing would; the workspace. */
const publishNotes = async (count: number): Promise<string> => {
  const workspaceId = await aWorkspaceRow(cloned.db);
  const { context } = aPublishWorld(workspaceId, systemClock, [NOTES, WIKI]);
  for (let n = 0; n < count; n += 1) {
    const noteId = `note-${String(n)}`;
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId, title: 't' });
    });
  }
  return workspaceId;
};

interface Delivery {
  readonly fact_id: string;
  readonly node: string;
}

const deliveries = async (): Promise<Delivery[]> =>
  (await sql<Delivery>`select fact_id, node from cluster_deliveries`.execute(cloned.db)).rows;

const outboxRows = async (workspaceId: string): Promise<{ state: string; attempts: number }[]> =>
  await cloned.db
    .selectFrom('outbox')
    .select(['state', 'attempts'])
    .where('workspace_id', '=', workspaceId)
    .execute();

/** Both workers tick once more, so that a second delivery of a fact, if there were one, has had its chance before it is judged. */
const oneMoreDrain = async (): Promise<void> => {
  await Bun.sleep(DRAIN_MS + 500);
};

const countBy = (rows: readonly Delivery[], node: string): number =>
  rows.filter((row) => row.node === node).length;

/** Nothing twice and nothing lost: the rows of the table are each fact once, and the outbox says each is delivered. */
const expectEachFactDeliveredOnce = async (
  workspaceId: string,
  published: number,
): Promise<void> => {
  const done = await deliveries();
  expect(done).toHaveLength(published);
  expect(new Set(done.map((row) => row.fact_id)).size).toBe(published);
  const rows = await outboxRows(workspaceId);
  expect(rows).toHaveLength(published);
  expect(rows.every((row) => row.state === 'delivered')).toBe(true);
};

describe('integration: two API processes run one consumer', () => {
  test('claim from one table and deliver every fact once, each fact tried once', async () => {
    const prefix = aClusterNamespace();
    const [first, second] = [aNode('first', prefix, SLOW_MS), aNode('second', prefix, SLOW_MS)];
    await Promise.all([untilReady(first, BOOT_MS), untilReady(second, BOOT_MS)]);
    // Ready is not yet working: the nodes have claimed nothing until a fact is there.
    expect(await deliveries()).toEqual([]);

    const total = 3 * BATCH;
    const workspaceId = await publishNotes(total);
    // Six drains' worth, shared by two nodes that tick every two seconds, and the pace of every delivery.
    await eventually(
      'every fact is delivered',
      async () => (await deliveries()).length >= total,
      6 * DRAIN_MS + total * SLOW_MS + 4 * LEASE_MS,
    );
    await oneMoreDrain();

    await expectEachFactDeliveredOnce(workspaceId, total);
    // Both processes claimed from the one table; neither was the only one at work.
    const done = await deliveries();
    expect(countBy(done, 'first')).toBeGreaterThan(0);
    expect(countBy(done, 'second')).toBeGreaterThan(0);
    // No fact needed a second try: a claim of one node was never taken by the other.
    expect((await outboxRows(workspaceId)).every((row) => row.attempts === 1)).toBe(true);
  }, 120_000);

  test('a node killed in the middle of its batch leaves its claims to lapse, and the survivor delivers the rest', async () => {
    const prefix = aClusterNamespace();
    // Slow deliveries: a batch takes two seconds, and the kill lands inside one.
    const [doomed, survivor] = [
      aNode('doomed', prefix, SLOW_MS),
      aNode('survivor', prefix, SLOW_MS),
    ];
    await Promise.all([untilReady(doomed, BOOT_MS), untilReady(survivor, BOOT_MS)]);

    const total = 2 * BATCH;
    const workspaceId = await publishNotes(total);
    await eventually(
      'the node that is to die has delivered some of its batch',
      async () => countBy(await deliveries(), 'doomed') >= 2,
      BOOT_MS,
    );
    doomed.process.kill('SIGKILL');
    await doomed.process.exited;
    expect(doomed.process.signalCode).toBe('SIGKILL');
    const before = (await deliveries()).length;
    expect(before).toBeLessThan(total);
    const doomedBefore = countBy(await deliveries(), 'doomed');

    await eventually(
      'the survivor has delivered everything',
      async () => (await deliveries()).length >= total,
      LEASE_MS + (total / BATCH + 2) * (DRAIN_MS + BATCH * SLOW_MS) + BOOT_MS,
    );
    await oneMoreDrain();

    await expectEachFactDeliveredOnce(workspaceId, total);
    // The dead node delivered nothing after it died, and what it had claimed and never delivered was tried again.
    expect(countBy(await deliveries(), 'doomed')).toBe(doomedBefore);
    expect((await outboxRows(workspaceId)).some((row) => row.attempts >= 2)).toBe(true);
    expect(survivor.process.exitCode).toBeNull();
  }, 180_000);

  test('a node asked to leave drains and exits cleanly, and the other delivers what is left', async () => {
    const prefix = aClusterNamespace();
    const [leaving, staying] = [
      aNode('leaving', prefix, SLOW_MS),
      aNode('staying', prefix, SLOW_MS),
    ];
    await Promise.all([untilReady(leaving, BOOT_MS), untilReady(staying, BOOT_MS)]);

    const total = 3 * BATCH;
    const workspaceId = await publishNotes(total);
    await eventually(
      'the node that is to leave has delivered some of its batch',
      async () => countBy(await deliveries(), 'leaving') >= 2,
      BOOT_MS,
    );
    leaving.process.kill('SIGTERM');
    // The drain's own deadline is ten seconds (`index.ts`); a node past it is a node that did not drain.
    const code = await Promise.race([
      leaving.process.exited,
      Bun.sleep(15_000).then(() => 'still running'),
    ]);
    expect(code).toBe(0);
    expect(
      leaving
        .said()
        .split('\n')
        .filter((line) => line.includes('"level":"error"')),
    ).toEqual([]);
    const leftBehind = countBy(await deliveries(), 'leaving');
    expect(leftBehind).toBeGreaterThanOrEqual(2);

    await eventually(
      'the node that stayed has delivered the rest',
      async () => (await deliveries()).length >= total,
      LEASE_MS + (total / BATCH + 2) * (DRAIN_MS + BATCH * SLOW_MS) + BOOT_MS,
    );
    await oneMoreDrain();

    await expectEachFactDeliveredOnce(workspaceId, total);
    expect(countBy(await deliveries(), 'leaving')).toBe(leftBehind);
    // It finished what it had claimed before it went: no claim was left to lapse, and no fact needed a second try.
    expect((await outboxRows(workspaceId)).every((row) => row.attempts === 1)).toBe(true);
  }, 180_000);
});
