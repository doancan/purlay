/**
 * Nodes of two releases run the same consumer's worker against one table (D-288, D-283 §2): each is a composition of its own
 * over a pool of its own, as API processes are, and the facts are those of a fake `notes` and `wiki`. The drain's tests
 * (`platform/outbox-drain.integration.test.ts`) hold the claim and the delivery; this holds what the composition does with them
 * in a rolling deploy: two older nodes never run a fact twice, they leave the newer shape pending with no try spent, and the
 * newer node takes it when it arrives.
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
  NOTE_FOLDER_DEFAULT,
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

describe('integration: nodes of two releases run the same consumer', () => {
  const OLDER_FACTS = [NOTE_CREATED, NOTE_PINNED];
  const NEWER_FACTS = [NOTE_CREATED_V2, NOTE_PINNED];
  const PER_SHAPE = 25;

  test('deliver every fact once, the newer shape only by the node that knows it, and an older node leaves it pending until then', async () => {
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
    type Release = 'older' | 'newer';
    const handledBy: Record<'older' | 'olderToo' | 'newer', string[]> = {
      older: [],
      olderToo: [],
      newer: [],
    };
    const node = (name: keyof typeof handledBy): ReturnType<typeof compose> => {
      const handle: FactConsumer = (fact) => {
        handledBy[name].push((fact.payload as { noteId: string }).noteId);
        return Promise.resolve('done');
      };
      const release: Release = name === 'newer' ? 'newer' : 'older';
      return compose(
        [notes, wikiWith(handle)],
        undefined,
        'open',
        release === 'older' ? OLDER_FACTS : NEWER_FACTS,
      );
    };
    const stateOf = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const row of await rowsOf(workspaceId)) counts[row.state] = (counts[row.state] ?? 0) + 1;
      return counts;
    };

    // The newer shape is published and only an older node is running: it takes what it knows and spends no try on the rest.
    for (let round = 0; round < 3; round += 1) await runWorkers(node('older'), second);
    expect(handledBy.older).toHaveLength(PER_SHAPE);
    expect(handledBy.older.every((id) => id.startsWith('v1-'))).toBe(true);
    const waiting = (await rowsOf(workspaceId)).filter((row) => row.state === 'pending');
    expect(waiting).toHaveLength(PER_SHAPE);
    expect(waiting.every((row) => row.shape === 2 && row.attempts === 0)).toBe(true);

    // Two older nodes run at the same moment, over and over, on more of the first shape: each fact is taken by one of them.
    for (let n = PER_SHAPE; n < 2 * PER_SHAPE; n += 1) {
      await cloned.db.transaction().execute(async (tx) => {
        await publishFact(tx, context, NOTE_CREATED, { noteId: `v1-${String(n)}`, title: 't' });
      });
    }
    for (let round = 0; round < 10 && (await stateOf())['pending'] !== PER_SHAPE; round += 1) {
      await Promise.all([
        runWorkers(node('older'), second),
        runWorkers(node('olderToo'), cloned.db),
      ]);
    }
    expect(await stateOf()).toEqual({ delivered: 2 * PER_SHAPE, pending: PER_SHAPE });

    // The newer node arrives and takes what was waiting for it, by the shape it wrote.
    for (let round = 0; round < 3; round += 1) await runWorkers(node('newer'), cloned.db);
    expect(await stateOf()).toEqual({ delivered: 3 * PER_SHAPE });

    const everything = [...handledBy.older, ...handledBy.olderToo, ...handledBy.newer];
    const published = [
      ...Array.from({ length: 2 * PER_SHAPE }, (_, n) => `v1-${String(n)}`),
      ...Array.from({ length: PER_SHAPE }, (_, n) => `v2-${String(n)}`),
    ];
    // Nothing twice, nothing lost, and the older nodes never held a fact of a shape they do not know.
    expect(new Set(everything).size).toBe(everything.length);
    expect(everything.toSorted()).toEqual(published.toSorted());
    expect([...handledBy.older, ...handledBy.olderToo].some((id) => id.startsWith('v2-'))).toBe(
      false,
    );
    expect(handledBy.newer).toHaveLength(PER_SHAPE);
  });

  test('a newer node that starts first delivers the older shape upgraded as well as its own, and kills nothing', async () => {
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
    const seen: { noteId: string; folder: string }[] = [];
    const handle: FactConsumer = (fact) => {
      seen.push(fact.payload as { noteId: string; folder: string });
      return Promise.resolve('done');
    };
    const newer = compose([notes, wikiWith(handle)], undefined, 'open', NEWER_FACTS);
    for (let round = 0; round < 5; round += 1) await runWorkers(newer, cloned.db);
    const states = (await rowsOf(workspaceId)).map((row) => row.state);
    expect(states).toEqual(Array.from({ length: 2 * PER_SHAPE }, () => 'delivered'));
    expect(seen).toHaveLength(2 * PER_SHAPE);
    expect(
      seen.every(
        (note) => note.folder === (note.noteId.startsWith('v1-') ? NOTE_FOLDER_DEFAULT : 'f'),
      ),
    ).toBe(true);
  });
});
