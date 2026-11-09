/**
 * The SQL form of the effective set (D-289 §10): the one question a worker, a job and a sweep ask of the database, held to the TS
 * function that is its specification over every kind of grant. What a loop written per workspace does with it is
 * `modules/workers/per-workspace.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { aGrant } from '../testing/facts';
import { aRoom } from '../testing/rooms';
import { effectiveModules, type EntitlementMode } from './module-kit/entitlement';
import { entitledWorkspaces } from './entitled-workspaces';
import type { ModuleManifest } from './module-kit/manifest';

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

const RUNNING = [
  manifestOf('base'),
  manifestOf('addon', { requires: ['base'] }),
  manifestOf('other'),
  manifestOf('kept', { entitlement: 'always' }),
];

const aWorkspace = async (db: Executor): Promise<string> =>
  (await aRoom(db, ['alice'])).workspaceId;

const IN_THE_PAST = new Date('2020-01-01T00:00:00Z');
const IN_THE_FUTURE = new Date('2999-01-01T00:00:00Z');

/** Workspaces for every shape a grant can take, each with the rows that make it. */
const grantShapes: readonly (readonly [
  string,
  (readonly [string, 'on' | 'off', Date | null])[],
])[] = [
  ['no rows', []],
  ['the base off', [['base', 'off', null]]],
  ['the addon off', [['addon', 'off', null]]],
  [
    'both on',
    [
      ['base', 'on', null],
      ['addon', 'on', null],
    ],
  ],
  [
    'the addon on and the base off',
    [
      ['base', 'off', null],
      ['addon', 'on', null],
    ],
  ],
  ['an expired addon off', [['addon', 'off', IN_THE_PAST]]],
  ['an expired addon on, in a server that gives nothing', [['addon', 'on', IN_THE_PAST]]],
  ['an addon on until a day far away', [['addon', 'on', IN_THE_FUTURE]]],
  [
    'everything off but kept',
    [
      ['base', 'off', null],
      ['other', 'off', null],
    ],
  ],
];

describe('integration: the SQL form of the effective modules', () => {
  for (const mode of ['open', 'managed'] as const satisfies readonly EntitlementMode[]) {
    for (const suspended of [[], ['base']]) {
      test(`answers as effectiveModules does, in ${mode} mode with ${suspended.length === 0 ? 'nothing' : suspended.join()} stopped`, async () => {
        await withRollback(async (db) => {
          const ids = new Map<string, string>();
          for (const [name, rows] of grantShapes) {
            const workspaceId = await aWorkspace(db);
            ids.set(workspaceId, name);
            for (const [module, state, validUntil] of rows) {
              await aGrant(db, workspaceId, module, state, validUntil);
            }
          }
          const stops = new Set(suspended);
          for (const module of RUNNING.map(({ id }) => id)) {
            const view = entitledWorkspaces(
              module,
              {
                running: RUNNING,
                mode,
                suspended: () => stops,
                effective: (rows, now) =>
                  effectiveModules({ running: RUNNING, rows, mode, now, suspended: stops }),
              },
              db,
            );
            const turns = await view.turns(undefined, 1_000);
            const fromSql = turns.map(({ workspaceId }) => workspaceId).filter((id) => ids.has(id));
            const expected: string[] = [];
            for (const workspaceId of [...ids.keys()].sort()) {
              const rows = (
                await db
                  .selectFrom('workspace_modules')
                  .select(['module', 'state', 'valid_until'])
                  .where('workspace_id', '=', workspaceId)
                  .execute()
              ).map((row) => ({
                module: row.module,
                state: row.state === 'on' ? ('on' as const) : ('off' as const),
                validUntil: row.valid_until,
              }));
              if (
                effectiveModules({
                  running: RUNNING,
                  rows,
                  mode,
                  now: new Date(),
                  suspended: stops,
                }).has(module)
              ) {
                expected.push(workspaceId);
              }
            }
            expect(fromSql, module).toEqual(expected);
            // Each turn says which modules its workspace may use, as the TS function does.
            for (const turn of turns.filter(({ workspaceId }) => ids.has(workspaceId))) {
              expect(turn.modules?.has(module)).toBe(true);
            }
          }
        });
      });
    }
  }

  test('is false for a module this process does not run', async () => {
    await withRollback(async (db) => {
      await aWorkspace(db);
      const view = entitledWorkspaces(
        'absent',
        { running: RUNNING, mode: 'open', suspended: () => new Set(), effective: () => new Set() },
        db,
      );
      expect(await view.turns(undefined, 10)).toEqual([]);
    });
  });

  test('pages in id order after a cursor, leaves out a deleted workspace and serves a sweep’s own statement', async () => {
    await withRollback(async (db) => {
      const made = [await aWorkspace(db), await aWorkspace(db), await aWorkspace(db)].sort();
      const [first = '', second = '', third = ''] = made;
      await sql`update workspaces set deleted_at = now() where id = ${second}`.execute(db);
      const view = entitledWorkspaces(
        'base',
        {
          running: RUNNING,
          mode: 'open',
          suspended: () => new Set(),
          effective: () => new Set(['base']),
        },
        db,
      );
      const all = (await view.turns(undefined, 1_000)).map(({ workspaceId }) => workspaceId);
      expect(all).toContain(first);
      expect(all).not.toContain(second);
      expect((await view.turns(first, 1_000)).map(({ workspaceId }) => workspaceId)).not.toContain(
        first,
      );
      expect((await view.turns(first, 1)).length).toBe(1);
      await aGrant(db, third, 'base', 'off');
      const swept = await db
        .selectFrom('workspaces')
        .select('id')
        .where('id', 'in', made)
        .where(view.has('workspaces.id'))
        .execute();
      // The condition is the grant alone: a deleted workspace is left out by the page and, for a sweep, by the purge that takes its rows.
      expect(swept.map(({ id }) => id).sort()).toEqual([first, second].sort());
    });
  });
});
