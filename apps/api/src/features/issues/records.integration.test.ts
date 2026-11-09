/**
 * Issues as the target of a link (D-291): a module that `uses` `issues.records` asks for an issue by id and is told its title or
 * that it is not available, the same answer for a provider that is not run, was stopped, is not granted to the workspace, an id
 * of another workspace, an issue that was deleted and an id that is no UUID. The module that links is a stand-in with the
 * manifest the real one will have; the composition, the registry and the database are the real ones.
 *
 * @needs-modules issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { compose, type BundledModule } from '../../composition';
import { noSuspension, type Suspension } from '../../platform/suspended-modules';
import type { ModuleRef, ResolvedRef } from '../../platform/ports/record-ref';
import { NOW } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { withinRequest } from '../../platform/logging';
import { aGrant } from '../../testing/facts';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { issuesModule } from './module';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const linking: BundledModule = {
  manifest: {
    id: 'linking',
    requires: [],
    optional: ['issues'],
    degrades: { issues: 'A linked issue is shown as the title saved with it, as text.' },
    provides: [],
    uses: ['issues.records'],
    budget: { none: 'a stand-in for the module that links' },
  },
};

const UNAVAILABLE: ResolvedRef = { status: 'unavailable' };
interface Asker {
  readonly workspaceId: string;
  readonly userId: string;
}

const stopped = (module: string): Suspension => ({
  ...noSuspension,
  current: () => new Set([module]),
});

let tick = 0;
const anIssue = async (db: Executor, workspaceId: string, title: string): Promise<ModuleRef> => {
  tick += 1;
  const id = messageId(new Date(NOW.getTime() + tick * 1_000));
  await db
    .insertInto('issues')
    .values({ id, workspace_id: workspaceId, title, body: '' })
    .execute();
  return { module: 'issues', type: 'issue', id };
};

const resolved = async (
  db: Executor,
  ref: ModuleRef,
  asker: Asker,
  world: { modules?: readonly BundledModule[]; suspension?: Suspension } = {},
): Promise<ResolvedRef> => {
  const running = world.modules ?? [issuesModule, linking];
  const composition = compose(
    running,
    [issuesModule, linking],
    'open',
    undefined,
    world.suspension,
  );
  const context = await requireWorkspaceMembership(db, asker.userId, asker.workspaceId);
  return await composition.portsFor('linking', db).resolveRef(ref, context);
};

const aWorkspace = async (db: Executor): Promise<Asker> => {
  const room = await aRoom(db, ['alice']);
  return { workspaceId: room.workspaceId, userId: room.members['alice']?.userId ?? '' };
};

describe('integration: an issue as the target of a link', () => {
  test('is shown by the title it has now, and renaming it changes the answer', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const ref = await anIssue(db, world.workspaceId, 'Rotate the key');
      expect(await resolved(db, ref, world)).toEqual({
        status: 'available',
        ref,
        label: 'Rotate the key',
      });
      await db
        .updateTable('issues')
        .set({ title: 'Rotate the keys' })
        .where('id', '=', ref.id)
        .execute();
      expect(await resolved(db, ref, world)).toMatchObject({ label: 'Rotate the keys' });
    });
  });

  test('is unavailable where issues is not run', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const ref = await anIssue(db, world.workspaceId, 'Rotate the key');
      expect(await resolved(db, ref, world, { modules: [linking] })).toEqual(UNAVAILABLE);
    });
  });

  test('is unavailable once the administrator stopped issues', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const ref = await anIssue(db, world.workspaceId, 'Rotate the key');
      expect(await resolved(db, ref, world, { suspension: stopped('issues') })).toEqual(
        UNAVAILABLE,
      );
    });
  });

  test('is unavailable in a workspace that is not granted issues, and available in one that is', async () => {
    await withRollback(async (db) => {
      const withheld = await aWorkspace(db);
      const granted = await aWorkspace(db);
      const forWithheld = await anIssue(db, withheld.workspaceId, 'Hidden by the edition');
      const forGranted = await anIssue(db, granted.workspaceId, 'Sold');
      await aGrant(db, granted.workspaceId, 'issues', 'on');
      // A server in `managed` mode gives a workspace with no row nothing: the guard reads the grants as a request does.
      const managed = compose([issuesModule, linking], [issuesModule, linking], 'managed');
      const entitlements = { effective: managed.effectiveModules, refused: (): void => undefined };
      const answer = async (ref: ModuleRef, asker: Asker): Promise<ResolvedRef> =>
        await withinRequest({ requestId: 'test', startedAt: 0, entitlements }, async () => {
          const context = await requireWorkspaceMembership(db, asker.userId, asker.workspaceId);
          return await managed.portsFor('linking', db).resolveRef(ref, context);
        });
      expect(await answer(forWithheld, withheld)).toEqual(UNAVAILABLE);
      expect(await answer(forGranted, granted)).toMatchObject({ status: 'available' });
    });
  });

  test('does not tell an issue of another workspace from one that is not there', async () => {
    await withRollback(async (db) => {
      const mine = await aWorkspace(db);
      const theirs = await aWorkspace(db);
      const foreign = await anIssue(db, theirs.workspaceId, 'Their secret roadmap');
      const missing = { ...foreign, id: messageId(new Date(NOW.getTime() + 999_000)) };
      expect(await resolved(db, foreign, mine)).toEqual(UNAVAILABLE);
      expect(await resolved(db, missing, mine)).toEqual(await resolved(db, foreign, mine));
    });
  });

  test('is unavailable for an issue that was deleted, and for ids and kinds issues does not have', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const ref = await anIssue(db, world.workspaceId, 'Short lived');
      await db.deleteFrom('issues').where('id', '=', ref.id).execute();
      expect(await resolved(db, ref, world)).toEqual(UNAVAILABLE);
      const kept = await anIssue(db, world.workspaceId, 'Kept');
      expect(await resolved(db, { ...kept, type: 'comment' }, world)).toEqual(UNAVAILABLE);
      expect(await resolved(db, { ...kept, id: "1' or true --" }, world)).toEqual(UNAVAILABLE);
      expect(await resolved(db, { ...kept, id: '' }, world)).toEqual(UNAVAILABLE);
    });
  });
});
