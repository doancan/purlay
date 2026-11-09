/**
 * A module's route can tell the build a fact (`ModuleRouteDependencies.publishFact`, D-283 §2): through the real application,
 * the fact is written in the handler's transaction as the module whose route it is, for each module that consumes it, and a
 * route that names a type another module owns is refused. Real PostgreSQL; the rows are read back from the table.
 *
 * Issues stands for the publisher and chat for the consumer, with facts of the test's own: a build of `createApp` carries only
 * the modules `ModuleId` names.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { Elysia, type AnyElysia } from 'elysia';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { defineFact, type FactDeclaration } from '@purlay/types';
import { compose, type BundledModule } from '../../composition';
import { chatModule } from '../../features/chat/module';
import { issuesRoutes } from '../../features/issues/http/routes';
import { issuesModule } from '../../features/issues/module';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';
import type { ModuleRouteDependencies } from './module-routes';
import { requireSession } from './session';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-11-08T12:00:00.000Z'));
const ISSUES_PATH = '/api/workspaces/:workspaceId/issues';

const schema = Type.Object({ note: Type.String({ maxLength: 20 }) });
const ISSUE_TOLD = defineFact({ type: 'issues.told', owner: 'issues', absent: 'drop', schema });
const CHAT_TOLD = defineFact({ type: 'chat.told', owner: 'chat', absent: 'drop', schema });

/** A route of issues that publishes `fact`, as the module whose routes these are. */
const publishing = (
  context: ModuleRouteDependencies<Executor>,
  path: string,
  fact: FactDeclaration,
): AnyElysia =>
  new Elysia().post(`${ISSUES_PATH}/${path}`, async ({ request, params }) => {
    const { userId } = await requireSession(context.auth, request);
    const tenancy = await requireWorkspaceMembership(context.database, userId, params.workspaceId);
    await atomicallyOn(context.database)(async (transaction) => {
      await context.publishFact(transaction, tenancy, fact, { note: 'hello' });
    });
    return { published: true };
  });

/** A route that publishes with a copy of its context aimed at another workspace: the spread type-checks. */
const forging = (context: ModuleRouteDependencies<Executor>): AnyElysia =>
  new Elysia().post(`${ISSUES_PATH}/forged`, async ({ request, params }) => {
    const { userId } = await requireSession(context.auth, request);
    const tenancy = await requireWorkspaceMembership(context.database, userId, params.workspaceId);
    const forged: WorkspaceContext = { ...tenancy, workspaceId: crypto.randomUUID() };
    await atomicallyOn(context.database)(async (transaction) => {
      await context.publishFact(transaction, forged, ISSUE_TOLD, { note: 'hello' });
    });
    return { published: true };
  });

const publisher: BundledModule = {
  ...issuesModule,
  manifest: { ...issuesModule.manifest, publishes: ['issues.told'] },
  routes: (context) =>
    new Elysia()
      .use(issuesRoutes(context))
      .use(publishing(context, 'told', ISSUE_TOLD))
      .use(publishing(context, 'stolen', CHAT_TOLD))
      .use(forging(context)),
};
const consumer: BundledModule = {
  ...chatModule,
  manifest: { ...chatModule.manifest, consumes: ['issues.told'] },
  factConsumers: { 'issues.told': () => Promise.resolve('done') },
};

const fixture = async (
  db: Executor,
): Promise<{ post: (path: string) => Promise<Response>; workspaceId: string }> => {
  const room = await aRoom(db, ['member']);
  const member = room.members['member'];
  if (member === undefined) throw new Error('Missing fixture person');
  const session = await aSession(db, clock, member.userId);
  const app = createApp(
    testDependencies({
      database: db,
      clock,
      composition: compose([consumer, publisher], [consumer, publisher], 'open', [
        ISSUE_TOLD,
        CHAT_TOLD,
      ]),
    }),
  );
  return {
    workspaceId: room.workspaceId,
    post: async (path) =>
      await app.handle(
        new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/issues/${path}`, {
          method: 'POST',
          headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
        }),
      ),
  };
};

const rowsOf = async (db: Executor, workspaceId: string): Promise<readonly string[]> =>
  (
    await db
      .selectFrom('outbox')
      .select(['producer', 'consumer', 'type'])
      .where('workspace_id', '=', workspaceId)
      .execute()
  ).map((row) => `${row.producer}>${row.consumer} ${row.type}`);

describe('integration: a route publishes a fact', () => {
  test('as its own module, for the module that consumes it', async () => {
    await withRollback(async (db) => {
      const { post, workspaceId } = await fixture(db);
      expect((await post('told')).status).toBe(200);
      expect(await rowsOf(db, workspaceId)).toEqual(['issues>chat issues.told']);
    });
  });

  test('and is refused when its context is a copy aimed at another workspace, leaving no row', async () => {
    await withRollback(async (db) => {
      const { post, workspaceId } = await fixture(db);
      expect((await post('forged')).status).toBe(500);
      expect(await rowsOf(db, workspaceId)).toEqual([]);
    });
  });

  test('and is refused when it names a type another module owns, leaving no row', async () => {
    await withRollback(async (db) => {
      const { post, workspaceId } = await fixture(db);
      expect((await post('stolen')).status).toBe(500);
      expect(await rowsOf(db, workspaceId)).toEqual([]);
    });
  });
});
