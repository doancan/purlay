/**
 * Two nodes of two releases run the same consumer's worker against one table (D-288, D-283 §2): each is a composition of its
 * own over a pool of its own, as two API processes are, and the facts are those of a fake `notes` and `wiki`. The drain's
 * tests (`platform/outbox-drain.integration.test.ts`) hold the claim and the delivery; this holds what the composition does with them
 * when a rolling deploy has an older node and a newer one at the same moment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  createDatabase,
  type ClonedDatabase,
  type DatabasePool,
  type Executor,
  type Outbox,
  type Selectable,
} from '@purlay/db';
import { compose, type BundledModule } from './composition';
import { startWorkers, type Later } from './modules/workers/module-workers';
import { fixedClock } from './platform/clock';
import type { FactConsumer } from './platform/fact-consumers';
import { publishFact } from './platform/outbox';
import { aRecordingLogger, NOW } from './testing/doubles';
import {
  aPublishWorld,
  aWorkspaceRow,
  NOTE_CREATED,
  NOTE_CREATED_V2,
  NOTE_PINNED,
  NOTES,
  WIKI,
} from './testing/facts';

let cloned: ClonedDatabase;
/** The pool of the second node, on the same database. */
let second: DatabasePool;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  second = createDatabase({ connectionString: cloned.connectionString, poolSize: 4 });
}, CLONE_HOOK_MS);
afterAll(async () => {
  await second.destroy();
  await cloned.drop();
}, DROP_HOOK_MS);

const clock = fixedClock(NOW);
const notes: BundledModule = { manifest: NOTES };
const wikiWith = (handle: FactConsumer): BundledModule => ({
  manifest: WIKI,
  factConsumers: { 'notes.created': handle, 'notes.pinned': handle },
});

const rowsOf = async (workspaceId: string): Promise<Selectable<Outbox>[]> =>
  await cloned.db
    .selectFrom('outbox')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('consumer', '=', 'wiki')
    .orderBy('id')
    .execute();

/** A loop that never comes round again: the first iteration is the whole of it, which `stop` waits for. */
const once: Later = () => () => undefined;

const runWorkers = async (
  composition: ReturnType<typeof compose>,
  database: Executor,
): Promise<void> => {
  const { log } = aRecordingLogger();
  const started = startWorkers(composition.workers, {
    database,
    clock,
    log,
    bus: {
      publish: () => Promise.resolve(),
      subscribe: () => true,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
    failures: {
      inc: () => undefined,
    },
    later: once,
  });
  await started.stop();
};

describe('integration: two nodes of two releases run the same consumer', () => {
  const OLDER_FACTS = [NOTE_CREATED, NOTE_PINNED];
  const NEWER_FACTS = [NOTE_CREATED_V2, NOTE_PINNED];
  const PER_SHAPE = 25;

  test('deliver every fact once, the newer shape only by the node that knows it, and the older node leaves it pending until then', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    for (let n = 0; n < PER_SHAPE; n += 1) {
      await cloned.db.transaction().execute(async (tx) => {
        await publishFact(tx, context, NOTE_CREATED, { noteId: `v1-${String(n)}`, title: 't' });
        await publishFact(tx, context, NOTE_CREATED_V2, {
          noteId: `v2-${String(n)}`,
          title: 't',
          folder: 'f',
        });
      });
    }
    const handledBy: Record<'older' | 'newer', string[]> = { older: [], newer: [] };
    const node = (name: 'older' | 'newer'): ReturnType<typeof compose> => {
      const handle: FactConsumer = (fact) => {
        handledBy[name].push((fact.payload as { noteId: string }).noteId);
        return Promise.resolve('done');
      };
      return compose(
        [notes, wikiWith(handle)],
        undefined,
        'open',
        name === 'older' ? OLDER_FACTS : NEWER_FACTS,
      );
    };
    const pending = async (): Promise<number> =>
      (await rowsOf(workspaceId)).filter((row) => row.state === 'pending').length;

    // The newer shape is published and only the older node is running: it takes what it knows and spends no try on the rest.
    for (let round = 0; round < 3; round += 1) await runWorkers(node('older'), second);
    expect(handledBy.older).toHaveLength(PER_SHAPE);
    expect(handledBy.older.every((id) => id.startsWith('v1-'))).toBe(true);
    const waiting = (await rowsOf(workspaceId)).filter((row) => row.state === 'pending');
    expect(waiting).toHaveLength(PER_SHAPE);
    expect(waiting.every((row) => row.shape === 2 && row.attempts === 0)).toBe(true);

    // Then both run at the same moment, over and over, on the rows that are left and on more of both shapes.
    for (let n = PER_SHAPE; n < 2 * PER_SHAPE; n += 1) {
      await cloned.db.transaction().execute(async (tx) => {
        await publishFact(tx, context, NOTE_CREATED, { noteId: `v1-${String(n)}`, title: 't' });
      });
    }
    for (let round = 0; round < 10 && (await pending()) > 0; round += 1) {
      await Promise.all([runWorkers(node('older'), second), runWorkers(node('newer'), cloned.db)]);
    }
    expect(await pending()).toBe(0);

    const everything = [...handledBy.older, ...handledBy.newer];
    const published = [
      ...Array.from({ length: 2 * PER_SHAPE }, (_, n) => `v1-${String(n)}`),
      ...Array.from({ length: PER_SHAPE }, (_, n) => `v2-${String(n)}`),
    ];
    // Nothing twice, nothing lost, and the older node never held a fact of a shape it does not know.
    expect(new Set(everything).size).toBe(everything.length);
    expect(everything.toSorted()).toEqual(published.toSorted());
    expect(handledBy.older.some((id) => id.startsWith('v2-'))).toBe(false);
    expect((await rowsOf(workspaceId)).every((row) => row.state === 'delivered')).toBe(true);
  });
});
