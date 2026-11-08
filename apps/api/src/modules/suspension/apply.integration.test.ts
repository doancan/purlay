/**
 * The one writer of the stopped modules, on a real database (D-296): what it refuses, what a repeat does, what else stops with a
 * module that others require, that stopping the product (an `always` module, or one it needs) asks to be meant, and that the
 * trail has one entry for each change, with the operator's own reason.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { aMovableClock, NOW } from '../../testing/doubles';
import { aUserRow } from '../../testing/users';
import type { EntitlementCatalogue } from '../entitlements/apply';
import { applySuspension, moduleStatuses, type SuspensionChange } from './apply';

afterAll(async () => {
  await closeIntegrationDatabase();
});

/** Moved between writes: the trail is ordered by ids made from the clock. */
const clock = aMovableClock(NOW);
const ACTOR = { source: 'cli', userId: null };

/** `chat` is the product (always), `base` a grant, `extra` a grant that requires it, and `app` an `always` module that requires `base`. */
const catalogue: EntitlementCatalogue = {
  mode: 'open',
  carried: [
    { id: 'chat', requires: [], entitlement: 'always' },
    { id: 'base', requires: [] },
    { id: 'extra', requires: ['base'] },
    { id: 'app', requires: ['base'], entitlement: 'always' },
  ],
};
const noApp: EntitlementCatalogue = {
  ...catalogue,
  carried: catalogue.carried.filter(({ id }) => id !== 'app'),
};

const stop = (module: string, extra: Partial<SuspensionChange> = {}): SuspensionChange => ({
  module,
  state: 'suspended',
  reason: 'misbehaving',
  ...extra,
});
const resume = (module: string): SuspensionChange => ({ module, state: 'running' });

/** The modules of the test's catalogue: a query asks about these rows and not about the table. */
const MODULES = ['chat', 'base', 'extra', 'app'];

const stoppedIn = async (db: Executor): Promise<{ module: string }[]> =>
  await db
    .selectFrom('suspended_modules')
    .select('module')
    .where('module', 'in', MODULES)
    .execute();

const trailOf = async (db: Executor): Promise<string[]> =>
  (
    await db
      .selectFrom('server_audit_log')
      .select(['action', 'target_module', 'note', 'actor_user_id'])
      .where('action', 'like', 'server.module_%')
      .orderBy('id')
      .execute()
  ).map((row) => `${row.action} ${String(row.target_module)} ${String(row.note)}`);

/** The fields an `AppError` refused, or `undefined` when nothing was refused. */
const refusalOf = async (
  promise: Promise<unknown>,
): Promise<Record<string, string> | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error.body.code === 'VALIDATION_FAILED' ? error.body.details.fields : undefined;
  }
};

describe('integration: stopping and resuming a module', () => {
  test('writes the row with who and why, records one entry, and again is the same', async () => {
    await withRollback(async (tx) => {
      const { userId } = await aUserRow(tx, 'Operator');
      const actor = { source: 'operator', userId };
      const first = await applySuspension(tx, clock, noApp, actor, stop('base'));
      expect(first.changed).toBe(true);
      expect([...first.suspended]).toEqual(['base']);
      clock.advance(1_000);
      const again = await applySuspension(
        tx,
        clock,
        noApp,
        actor,
        stop('base', { reason: 'other words' }),
      );
      expect(again.changed).toBe(false);
      expect(
        await tx
          .selectFrom('suspended_modules')
          .select(['module', 'reason', 'source', 'suspended_by'])
          .where('module', 'in', MODULES)
          .execute(),
      ).toEqual([
        { module: 'base', reason: 'misbehaving', source: 'operator', suspended_by: userId },
      ]);
      expect(await trailOf(tx)).toEqual(['server.module_suspended base misbehaving']);

      clock.advance(1_000);
      expect((await applySuspension(tx, clock, noApp, actor, resume('base'))).changed).toBe(true);
      clock.advance(1_000);
      expect((await applySuspension(tx, clock, noApp, actor, resume('base'))).changed).toBe(false);
      expect(await stoppedIn(tx)).toEqual([]);
      expect(await trailOf(tx)).toEqual([
        'server.module_suspended base misbehaving',
        'server.module_resumed base null',
      ]);
    });
  });

  test('refuses a module the build lacks and a stop with no words, 1 to 200 characters, and writes nothing', async () => {
    await withRollback(async (tx) => {
      expect(
        await refusalOf(applySuspension(tx, clock, noApp, ACTOR, stop('tasks'))),
      ).toHaveProperty('module');
      for (const reason of [undefined, '', '   ', 'x'.repeat(201)])
        expect(
          await refusalOf(applySuspension(tx, clock, noApp, ACTOR, stop('base', { reason }))),
        ).toHaveProperty('reason');
      expect(
        (await applySuspension(tx, clock, noApp, ACTOR, stop('base', { reason: 'x'.repeat(200) })))
          .changed,
      ).toBe(true);
    });
    await withRollback(async (tx) => {
      expect(await stoppedIn(tx)).toEqual([]);
      expect(await trailOf(tx)).toEqual([]);
    });
  });

  test('stops what requires the module with it, and brings it back with it, naming it', async () => {
    await withRollback(async (tx) => {
      const stopped = await applySuspension(tx, clock, noApp, ACTOR, stop('base'));
      expect(stopped.alsoAffected).toEqual(['extra']);
      // The table holds what the operator named and nothing more.
      expect([...stopped.suspended]).toEqual(['base']);
      const resumed = await applySuspension(tx, clock, noApp, ACTOR, resume('base'));
      expect(resumed.alsoAffected).toEqual(['extra']);
      expect(await stoppedIn(tx)).toEqual([]);
    });
  });

  test('says which modules are stopped and which are out because of one that is', async () => {
    await withRollback(async (tx) => {
      const states = async (): Promise<string[]> =>
        (await moduleStatuses(tx, noApp, NOW)).map(({ module, state }) => `${module}:${state}`);
      expect(await states()).toEqual(['chat:active', 'base:active', 'extra:active']);
      await applySuspension(tx, clock, noApp, ACTOR, stop('base'));
      expect(await states()).toEqual(['chat:active', 'base:suspended', 'extra:blocked']);
    });
  });

  test('asks to be meant when it takes down a module that is always granted, itself or by what it requires', async () => {
    await withRollback(async (tx) => {
      expect(
        await refusalOf(applySuspension(tx, clock, catalogue, ACTOR, stop('chat'))),
      ).toHaveProperty('force');
      // `app` is always granted and requires `base`: stopping the grant takes the product's module with it.
      expect(
        await refusalOf(applySuspension(tx, clock, catalogue, ACTOR, stop('base'))),
      ).toHaveProperty('force');
      expect(await stoppedIn(tx)).toEqual([]);
      expect(await trailOf(tx)).toEqual([]);
      const forced = await applySuspension(
        tx,
        clock,
        catalogue,
        ACTOR,
        stop('base', { force: true }),
      );
      expect(forced.alsoAffected).toEqual(['extra', 'app']);
      expect(
        (await applySuspension(tx, clock, catalogue, ACTOR, stop('chat', { force: true }))).changed,
      ).toBe(true);
      // Letting them run again is never asked twice.
      expect((await applySuspension(tx, clock, catalogue, ACTOR, resume('chat'))).changed).toBe(
        true,
      );
    });
  });

  test('does not ask again for a module that is already out because of a stop that was meant', async () => {
    await withRollback(async (tx) => {
      await applySuspension(tx, clock, catalogue, ACTOR, stop('base', { force: true }));
      expect((await applySuspension(tx, clock, catalogue, ACTOR, stop('app'))).changed).toBe(true);
    });
  });
});
