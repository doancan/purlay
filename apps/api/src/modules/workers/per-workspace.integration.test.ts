/**
 * A loop written per workspace (D-289 §10): it touches the workspaces its module may act for and no other, one that lost the
 * grant is not touched at the next run, and a module the administrator stopped does nothing. The statement that decides is
 * `platform/entitled-workspaces.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, type Executor } from '@purlay/db';
import { compose, type BundledModule } from '../../composition';
import { ENTITLED_PAGE_SIZE } from '../../platform/entitled-workspaces';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import type { ModuleManifest } from '../../platform/module-kit/manifest';
import { noSuspension, type Suspension } from '../../platform/suspended-modules';
import { assertTurn } from '../../platform/workspace-turn';
import { aRecordingLogger } from '../../testing/doubles';
import { aGrant } from '../../testing/facts';
import { aRoom } from '../../testing/rooms';
import { withRollback } from '@purlay/db';
import { perWorkspaceWorker, type WorkerWork } from './module-workers';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const manifestOf = (id: string, rest: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id,
  requires: [],
  optional: [],
  degrades: {},
  provides: [],
  budget: { none: 'a module of the test' },
  ...rest,
});

const stopping = (...modules: string[]): Suspension => ({
  ...noSuspension,
  current: () => new Set(modules),
});

const bus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const aWorkspace = async (db: Executor): Promise<string> =>
  (await aRoom(db, ['alice'])).workspaceId;

describe('integration: a loop written per workspace', () => {
  const sweeping = (visited: string[]): BundledModule => ({
    manifest: manifestOf('base', { entitlement: 'grant' }),
    workers: [
      {
        name: 'sweep',
        intervalMs: 5_000,
        work: perWorkspaceWorker((turn) => {
          visited.push(turn.workspaceId);
          return Promise.resolve();
        }),
      },
    ],
  });

  const tick = async (
    module: BundledModule,
    db: Executor,
    suspension: Suspension = noSuspension,
  ): Promise<void> => {
    const composition = compose([module], [module], 'open', undefined, suspension);
    const worker = composition.workers.find(({ name }) => name === 'sweep');
    const work: WorkerWork | undefined = worker?.work;
    await work?.({
      database: db,
      clock: fixedClock(new Date()),
      log: aRecordingLogger().log,
      bus,
      ports: composition.portsFor('base', db),
      entitled: composition.entitledFor('base', db),
    });
  };

  test('touches the workspaces its module may act for, and not one that lost the grant, from the next run', async () => {
    await withRollback(async (db) => {
      const kept = await aWorkspace(db);
      const lost = await aWorkspace(db);
      const visited: string[] = [];
      const module = sweeping(visited);
      await tick(module, db);
      expect(visited).toContain(kept);
      expect(visited).toContain(lost);
      visited.length = 0;
      await aGrant(db, lost, 'base', 'off');
      await tick(module, db);
      expect(visited).toContain(kept);
      expect(visited).not.toContain(lost);
    });
  });

  test('is visited with workspaces the framework handed out, which the seams accept', async () => {
    await withRollback(async (db) => {
      await aWorkspace(db);
      let refused: unknown = 'not asked';
      const module: BundledModule = {
        manifest: manifestOf('base', { entitlement: 'grant' }),
        workers: [
          {
            name: 'sweep',
            intervalMs: 5_000,
            work: perWorkspaceWorker((turn) => {
              try {
                assertTurn(turn);
                refused = undefined;
              } catch (error) {
                refused = error;
              }
              return Promise.resolve();
            }),
          },
        ],
      };
      await tick(module, db);
      expect(refused).toBeUndefined();
    });
  });

  test('does nothing for a module the administrator stopped', async () => {
    await withRollback(async (db) => {
      await aWorkspace(db);
      const visited: string[] = [];
      await tick(sweeping(visited), db, stopping('base'));
      expect(visited).toEqual([]);
    });
  });

  test('walks more workspaces than a page holds, each once', async () => {
    await withRollback(async (db) => {
      const target = ENTITLED_PAGE_SIZE + 5;
      const made: string[] = [];
      for (let count = 0; count < target; count += 1) made.push(await aWorkspace(db));
      const visited: string[] = [];
      await tick(sweeping(visited), db);
      expect(new Set(visited.filter((id) => made.includes(id))).size).toBe(target);
      expect(visited.length).toBe(new Set(visited).size);
    });
  });
});
