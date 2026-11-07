/**
 * The find's fan-out (D-285) with a third module's source beside chat's and issues': a fake `notes` module, as
 * `frame-handlers.test.ts` has a fake module for the frames. What is proved is the part that is not any module's: a source is
 * asked as its own module, a source of a module that is off is answered `off` and never asked, a slow source is answered `slow`
 * at its deadline while the others' groups come back without waiting for it and its database work is cancelled, one that throws
 * is answered `error` with nothing of its message in the answer, and one that answers too many has its answer cut.
 *
 * @needs-modules chat
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type FindHit } from '@purlay/types';
import { bundledModules, compose, type BundledModule } from '../../composition';
import { currentRequest } from '../../platform/logging';
import { createLogger } from '../../platform/logging';
import type { SearchSource } from '../../platform/ports/search-source';
import { deadlinesOf } from '../../platform/request-deadline';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
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
  };
};

const asAlice = async (db: Executor): Promise<Parameters<typeof findAcross>[1]> => {
  const room = await aRoom(db, ['alice']);
  const userId = room.members['alice']?.userId ?? '';
  return await requireWorkspaceMembership(db, userId, room.workspaceId);
};

const sourcesOf = (found: Awaited<ReturnType<typeof findAcross>>): string[] =>
  found.groups.map((group) => group.source);

describe('integration: find fan-out', () => {
  test('a third module’s source is asked as that module, with the words and the limit', async () => {
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
      expect(sourcesOf(found)).toEqual(['messages', 'notes']);
      expect(seen).toEqual([['notes', 'deploy', 7, context]]);
      expect(found.skipped).toEqual([]);
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
      expect(sourcesOf(found)).toEqual(['messages']);
      expect(found.skipped).toEqual([{ source: 'notes', reason: 'off' }]);
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
      expect(sourcesOf(found)).toEqual(['messages']);
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
      expect(JSON.stringify(found)).not.toContain('on fire');
      expect(sourcesOf(found)).toEqual(['messages']);
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
      expect(found.groups[1]?.hits.map((hit) => hit.title)).toEqual(['one', 'two']);
    });
  });
});
