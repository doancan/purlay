/**
 * A fact crosses from one module to another through the composition and its workers (D-288, D-283 §2), with a fake third module
 * and real PostgreSQL: `notes` publishes in its transaction, `wiki` consumes in the worker the composition made for it, under its
 * module's share, and a fact whose consumer was off waits and is delivered when it is on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Outbox,
  type Selectable,
} from '@purlay/db';
import { compose, type BundledModule } from '../../composition';
import type { FactConsumer } from '../../platform/fact-consumers';
import { currentRequest } from '../../platform/logging';
import { fixedClock } from '../../platform/clock';
import { publishFact } from '../../platform/outbox';
import { aRecordingLogger, NOW } from '../../testing/doubles';
import {
  aGrant,
  aPublishWorld,
  aWorkspaceRow,
  NOTE_CREATED,
  NOTE_PINNED,
  NOTES,
  WIKI,
} from '../../testing/facts';
import { noSeam, type ModuleSeams } from '../../platform/ports/module-seams';
import { startWorkers, type Later } from './module-workers';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const FACTS = [NOTE_CREATED, NOTE_PINNED];
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
  seamsFor?: (module: string) => ModuleSeams,
): Promise<{ failures: Record<string, string>[]; lines: Record<string, unknown>[] }> => {
  const { log, lines } = aRecordingLogger();
  const failures: Record<string, string>[] = [];
  const started = startWorkers(composition.workers, {
    database: cloned.db,
    clock,
    log,
    bus: {
      publish: () => Promise.resolve(),
      subscribe: () => true,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
    failures: {
      inc: (labels) => {
        failures.push(labels);
      },
    },
    ...(seamsFor === undefined ? {} : { seamsFor }),
    later: once,
  });
  await started.stop();
  return { failures, lines };
};

describe('integration: what a consumer is handed by its worker', () => {
  test('is the seams of its module, bound to the delivery’s workspace and to the fact it is delivering', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n9', title: 'Plan' });
    });
    const factId = (
      await cloned.db
        .selectFrom('outbox')
        .select('fact_id')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow()
    ).fact_id;
    const bound: [string, string, string | undefined][] = [];
    const asked: string[] = [];
    const seams = (module: string): ModuleSeams => {
      asked.push(module);
      return {
        announce: () => Promise.resolve(),
        bind: (_transaction, turn, causedBy): ReturnType<ModuleSeams['bind']> => {
          bound.push([module, turn.workspaceId, causedBy]);
          return { written: () => [], seam: noSeam };
        },
      };
    };
    await runWorkers(
      compose([notes, wikiWith(() => Promise.resolve('done'))], undefined, 'open', FACTS),
      seams,
    );
    expect(asked).toContain('wiki');
    expect(bound).toEqual([['wiki', workspaceId, factId]]);
  });
});

describe('integration: a burst of facts', () => {
  test('is drained in one iteration of the worker while batches come back full, and not one batch for each interval', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    const BURST = 70;
    await cloned.db.transaction().execute(async (tx) => {
      for (let n = 0; n < BURST; n += 1) {
        await publishFact(tx, context, NOTE_CREATED, { noteId: `b${String(n)}`, title: 't' });
      }
    });
    const handle: FactConsumer = () => Promise.resolve('done');
    await runWorkers(compose([notes, wikiWith(handle)], undefined, 'open', FACTS));
    const rows = await rowsOf(workspaceId);
    expect(rows).toHaveLength(BURST);
    expect(rows.every((row) => row.state === 'delivered')).toBe(true);
  });
});

describe('integration: a fact between two modules', () => {
  test('is delivered by the consumer’s worker, as the consumer, in the transaction that marks it', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n1', title: 'Plan' });
    });
    const seen: unknown[] = [];
    const handle: FactConsumer = (fact) => {
      seen.push([fact.type, fact.workspaceId, fact.payload, currentRequest()?.module]);
      return Promise.resolve('done');
    };
    const { failures } = await runWorkers(
      compose([notes, wikiWith(handle)], undefined, 'open', FACTS),
    );
    expect(seen).toEqual([['notes.created', workspaceId, { noteId: 'n1', title: 'Plan' }, 'wiki']]);
    expect((await rowsOf(workspaceId))[0]).toMatchObject({ state: 'delivered', attempts: 1 });
    expect(failures).toEqual([]);
  });

  test('that its handler throws on is tried again at its backoff, and is no failure of the worker', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock);
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n2', title: 'Plan' });
    });
    const handle: FactConsumer = () => Promise.reject(new Error('the channel is unreachable'));
    const { failures, lines } = await runWorkers(
      compose([notes, wikiWith(handle)], undefined, 'open', FACTS),
    );
    expect((await rowsOf(workspaceId))[0]).toMatchObject({
      state: 'pending',
      attempts: 1,
      last_error: 'Error',
    });
    expect(failures).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain('unreachable');
  });

  test('of a workspace that is not granted the consumer waits, and is delivered when the grant is given', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, workspaceId, 'wiki', 'off');
    const { context } = aPublishWorld(workspaceId, clock);
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_CREATED, { noteId: 'n4', title: 'Plan' });
    });
    const handled: string[] = [];
    const handle: FactConsumer = (fact) => {
      handled.push(fact.workspaceId);
      return Promise.resolve('done');
    };
    const composition = compose([notes, wikiWith(handle)], undefined, 'open', FACTS);
    await runWorkers(composition);
    expect(handled).toEqual([]);
    expect((await rowsOf(workspaceId))[0]).toMatchObject({ state: 'pending', attempts: 0 });

    await cloned.db
      .deleteFrom('workspace_modules')
      .where('workspace_id', '=', workspaceId)
      .execute();
    await runWorkers(composition);
    expect(handled).toEqual([workspaceId]);
    expect((await rowsOf(workspaceId))[0]).toMatchObject({ state: 'delivered' });
  });

  test('that was published while its consumer was off and is held waits, and is delivered when the consumer runs', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const { context } = aPublishWorld(workspaceId, clock, [NOTES]);
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'n3' });
    });
    const handled: string[] = [];
    const handle: FactConsumer = (fact) => {
      handled.push(fact.type);
      return Promise.resolve('done');
    };
    const off = compose([notes], [notes, wikiWith(handle)], 'open', FACTS);
    expect(off.workers).toEqual([]);
    await runWorkers(off);
    expect((await rowsOf(workspaceId))[0]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(handled).toEqual([]);

    await runWorkers(compose([notes, wikiWith(handle)], undefined, 'open', FACTS));
    expect(handled).toEqual(['notes.pinned']);
    expect((await rowsOf(workspaceId))[0]).toMatchObject({ state: 'delivered' });
  });
});
