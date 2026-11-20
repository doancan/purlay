/**
 * The find's fan-out (D-285) with a third module's source beside chat's and issues': a fake `notes` module, as
 * `frame-handlers.test.ts` has a fake module for the frames. What is proved is the part that is not any module's: a source is
 * asked as its own module, a source of a module that is off is answered `off` and never asked, a slow source is answered `slow`
 * at its deadline while the others' groups come back without waiting for it and its database work is cancelled, one that throws
 * is answered `error` with nothing of its message in the answer, and one that answers too many has its answer cut.
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type FindHit } from '@purlay/types';
import { bundledModules, compose, type BundledModule } from '../../composition';
import { currentRequest } from '../../platform/logging';
import { createLogger } from '../../platform/logging';
import type { SearchSource } from '../../platform/ports/search-source';
import { renderMetrics, serverMetrics } from '../../platform/metrics';
import { deadlinesOf } from '../../platform/request-deadline';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
import { readExposition, sampleOf } from '../../testing/exposition';
import { aRoom } from '../../testing/rooms';
import { findAcross, type FindDependencies } from './find';

afterAll(async () => {
  await closeIntegrationDatabase();
});

/** Long enough for a real query on a busy machine, short enough to wait for. */
const DEADLINE_MS = 250;

const aNotesModule = (source: SearchSource): BundledModule => ({
  manifest: {
    id: 'notes',
    requires: [],
    optional: [],
    degrades: {},
    provides: [],
    budget: { none: 'a test module' },
    searchSources: [source.id],
  },
  searchSources: [source],
});

const aHit = (title: string): FindHit => ({
  id: messageId(NOW),
  title,
  excerpt: null,
  at: NOW.toISOString(),
  target: { type: 'issue', issueId: messageId(NOW) },
});

const dependenciesFor = (
  database: Executor,
  notes: BundledModule,
  running: readonly BundledModule[] = [...bundledModules, notes],
): FindDependencies => {
  const carried = [...bundledModules, notes];
  const composition = compose(running, carried);
  return {
    database,
    log: createLogger({ level: 'silent' }),
    sources: composition.findSources,
    off: composition.findSourcesOff,
    deadlineOf: deadlinesOf(carried.map((module) => module.manifest)),
    sourceDeadlineMs: DEADLINE_MS,
    metrics: serverMetrics(),
  };
};

const asAlice = async (db: Executor): Promise<Parameters<typeof findAcross>[1]> => {
  const room = await aRoom(db, ['alice']);
  const userId = room.members['alice']?.userId ?? '';
  await db
    .insertInto('issues')
    .values({ id: messageId(NOW), workspace_id: room.workspaceId, title: 'Deploy checklist' })
    .execute();
  return await requireWorkspaceMembership(db, userId, room.workspaceId);
};

const sourcesOf = (found: Awaited<ReturnType<typeof findAcross>>): string[] =>
  found.groups.map((group) => group.source);

describe('integration: find fan-out', () => {
  test('a third module’s source is asked as that module, with the words and one more than the limit', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const seen: unknown[] = [];
      const notes = aNotesModule({
        id: 'notes',
        search: (input) => {
          seen.push([currentRequest()?.module, input.query, input.limit, input.context]);
          return Promise.resolve([aHit('a note')]);
        },
      });
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 7);
      expect(sourcesOf(found)).toEqual(['messages', 'issues', 'notes']);
      expect(seen).toEqual([['notes', 'deploy', 8, context]]);
      expect(found.skipped).toEqual([]);
      expect(found.partial).toBe(false);
    });
  });

  test('a context the guard did not mint is refused before any source is asked', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      let asked = 0;
      const notes = aNotesModule({
        id: 'notes',
        search: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      });
      const forged = { ...context, workspaceId: crypto.randomUUID() };
      let refusal: unknown;
      try {
        await findAcross(dependenciesFor(db, notes), forged, 'deploy', 7);
      } catch (error) {
        refusal = error;
      }
      expect(String(refusal)).toContain('did not mint');
      expect(asked).toBe(0);
    });
  });

  test('a source of a module that is off is answered off and never asked', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      let asked = 0;
      const notes = aNotesModule({
        id: 'notes',
        search: () => {
          asked += 1;
          return Promise.resolve([aHit('a note')]);
        },
      });
      const running = bundledModules;
      const found = await findAcross(dependenciesFor(db, notes, running), context, 'deploy', 10);
      expect(sourcesOf(found)).toEqual(['messages', 'issues']);
      expect(found.skipped).toEqual([{ source: 'notes', reason: 'off' }]);
      expect(found.partial).toBe(false);
      expect(asked).toBe(0);
    });
  });

  test('a slow source is skipped at its deadline, the others answer, and its work is cancelled', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      let cancelled = false;
      const notes = aNotesModule({
        id: 'notes',
        search: () =>
          new Promise<readonly FindHit[]>(() => {
            currentRequest()?.signal?.addEventListener('abort', () => (cancelled = true));
          }),
      });
      const started = performance.now();
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 10);
      const took = performance.now() - started;
      expect(found.skipped).toEqual([{ source: 'notes', reason: 'slow' }]);
      // What finished in time is answered, and the answer says it is not all there is.
      expect(found.partial).toBe(true);
      expect(sourcesOf(found)).toEqual(['messages', 'issues']);
      expect(found.groups[1]?.hits.map((hit) => hit.title)).toEqual(['Deploy checklist']);
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
      expect(took).toBeLessThan(DEADLINE_MS * 4);
      expect(cancelled).toBe(true);
    });
  });

  test('a module’s own shorter deadline holds its source sooner than the find’s', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const notes: BundledModule = {
        ...aNotesModule({
          id: 'notes',
          search: () => new Promise<readonly FindHit[]>(() => undefined),
        }),
        manifest: {
          id: 'notes',
          requires: [],
          optional: [],
          degrades: {},
          provides: [],
          budget: { none: 'a test module' },
          deadline: { ms: 1_000 },
          searchSources: ['notes'],
        },
      };
      const found = await findAcross(
        { ...dependenciesFor(db, notes), sourceDeadlineMs: 5_000 },
        context,
        'deploy',
        10,
      );
      expect(found.skipped).toEqual([{ source: 'notes', reason: 'slow' }]);
    });
  });

  test('a source that throws is skipped as an error, and its message is not in the answer', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const notes = aNotesModule({
        id: 'notes',
        search: () => Promise.reject(new Error('the note index is on fire')),
      });
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 10);
      expect(found.skipped).toEqual([{ source: 'notes', reason: 'error' }]);
      expect(found.partial).toBe(true);
      expect(JSON.stringify(found)).not.toContain('on fire');
      expect(sourcesOf(found)).toEqual(['messages', 'issues']);
    });
  });

  test('a source that answers more than it was asked for has its answer cut to the limit', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const notes = aNotesModule({
        id: 'notes',
        search: () => Promise.resolve([aHit('one'), aHit('two'), aHit('three')]),
      });
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 2);
      expect(found.groups[2]?.hits.map((hit) => hit.title)).toEqual(['one', 'two']);
      expect(found.groups[2]?.more).toBe(true);
    });
  });

  test('a huge source costs the answer its limit, says it had more, and does not hold up the others', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const huge = Array.from({ length: 10_000 }, (_, at) => aHit(`note ${String(at)}`));
      const notes = aNotesModule({ id: 'notes', search: () => Promise.resolve(huge) });
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 10);
      const group = found.groups.find(({ source }) => source === 'notes');
      expect(group?.hits).toHaveLength(10);
      expect(group?.hits[0]?.title).toBe('note 0');
      expect(group?.more).toBe(true);
      expect(found.groups.find(({ source }) => source === 'issues')?.more).toBe(false);
      expect(found.partial).toBe(false);
    });
  });

  test('a source that answers exactly the limit has no more', async () => {
    await withRollback(async (db) => {
      const context = await asAlice(db);
      const notes = aNotesModule({
        id: 'notes',
        search: () => Promise.resolve([aHit('one'), aHit('two')]),
      });
      const found = await findAcross(dependenciesFor(db, notes), context, 'deploy', 2);
      expect(found.groups[2]?.hits).toHaveLength(2);
      expect(found.groups[2]?.more).toBe(false);
    });
  });
});

describe('integration: what the find counts of each source', () => {
  const NOTES = { module: 'notes', source: 'notes' };
  const ISSUES = { module: 'issues', source: 'issues' };

  /** The find asked once with `notes` beside the bundled sources, and the page its metrics make. */
  const findOnce = async (
    db: Executor,
    search: SearchSource['search'],
    running?: readonly BundledModule[],
  ): Promise<ReturnType<typeof readExposition>> => {
    const context = await asAlice(db);
    const notes = aNotesModule({ id: 'notes', search });
    const metrics = serverMetrics();
    await findAcross({ ...dependenciesFor(db, notes, running), metrics }, context, 'deploy', 10);
    return readExposition(renderMetrics(metrics));
  };

  const skips = (page: ReturnType<typeof readExposition>, series: typeof NOTES): number[] =>
    ['off', 'slow', 'error'].map(
      (reason) => sampleOf(page, 'purlay_search_source_skipped_total', { ...series, reason }) ?? 0,
    );

  test('a source that answers is timed once, under its module, and counted as no skip', async () => {
    await withRollback(async (db) => {
      const page = await findOnce(db, () => Promise.resolve([aHit('a note')]));
      expect(sampleOf(page, 'purlay_search_source_duration_seconds_count', NOTES)).toBe(1);
      expect(sampleOf(page, 'purlay_search_source_duration_seconds_count', ISSUES)).toBe(1);
      expect(skips(page, NOTES)).toEqual([0, 0, 0]);
    });
  });

  test('a slow source is counted slow and timed at its deadline, and the others are not counted skipped', async () => {
    await withRollback(async (db) => {
      const page = await findOnce(db, () => new Promise<readonly FindHit[]>(() => undefined));
      expect(skips(page, NOTES)).toEqual([0, 1, 0]);
      expect(skips(page, ISSUES)).toEqual([0, 0, 0]);
      expect(sampleOf(page, 'purlay_search_source_duration_seconds_count', NOTES)).toBe(1);
      const took = sampleOf(page, 'purlay_search_source_duration_seconds_sum', NOTES) ?? 0;
      expect(took).toBeGreaterThanOrEqual((DEADLINE_MS - 20) / 1_000);
      expect(took).toBeLessThan((DEADLINE_MS * 4) / 1_000);
    });
  });

  test('a source that throws is counted as an error and timed', async () => {
    await withRollback(async (db) => {
      const page = await findOnce(db, () => Promise.reject(new Error('the note index is on fire')));
      expect(skips(page, NOTES)).toEqual([0, 0, 1]);
      expect(sampleOf(page, 'purlay_search_source_duration_seconds_count', NOTES)).toBe(1);
    });
  });

  test('a source of a module that is off is counted off under its module and never timed', async () => {
    await withRollback(async (db) => {
      const chatOff = bundledModules.filter(({ manifest }) => manifest.id !== 'chat');
      const page = await findOnce(db, () => Promise.resolve([]), chatOff);
      // Chat's source is `messages`: the module is the manifest's, not the source's id.
      const MESSAGES = { module: 'chat', source: 'messages' };
      expect(skips(page, MESSAGES)).toEqual([1, 0, 0]);
      expect(
        sampleOf(page, 'purlay_search_source_duration_seconds_count', MESSAGES),
      ).toBeUndefined();
      expect(skips(page, NOTES)).toEqual([1, 0, 0]);
      expect(sampleOf(page, 'purlay_search_source_duration_seconds_count', ISSUES)).toBe(1);
    });
  });
});
