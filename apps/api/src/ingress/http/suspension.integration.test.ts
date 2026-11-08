/**
 * A module the administrator has stopped is no route on any node, for any workspace, within the TTL (D-296): every endpoint of it
 * answers a member, a stranger and a caller with no session as a process that does not run the module does, byte for byte; the
 * session and the search stop naming it; nothing it holds is deleted; and lifting the stop brings everything back. The stop is
 * read through the real cache over the real table, so what is shown is what a second node would do, which asks the same table.
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { defineFact } from '@purlay/types';
import { Elysia } from 'elysia';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import {
  bundledModules,
  compose,
  compositionFor,
  type BundledModule,
  type Composition,
} from '../../composition';
import { chatModule } from '../../features/chat/module';
import { issuesModule } from '../../features/issues/module';
import { fixedClock } from '../../platform/clock';
import { createLogger } from '../../platform/logging';
import { renderMetrics, serverMetrics, moduleSuspendedFamily } from '../../platform/metrics';
import { ownsPath } from '../../platform/module-kit/routes';
import {
  SUSPENSION_TTL_MS,
  readSuspended,
  suspensionCache,
  type Suspension,
} from '../../platform/suspended-modules';
import { CROSS_TENANT, pathFor, requestInit, type Ids } from '../../testing/cross-tenant';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { aWorkspaceRow } from '../../testing/facts';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { createApp } from './app';
import type { ModuleRouteDependencies } from './module-routes';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';
const silent = createLogger({ level: 'silent' });

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** The stop as a node reads it: the table, through the cache, on a clock the test moves. */
const aNode = (
  db: Executor,
  run: (suspension: Suspension) => Composition = (suspension) =>
    compositionFor(undefined, 'open', suspension),
): {
  readonly suspension: Suspension;
  readonly advance: (ms: number) => void;
  readonly call: (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
  ) => Promise<Answer>;
  readonly metrics: ReturnType<typeof serverMetrics>;
} => {
  let at = 0;
  const suspension = suspensionCache({
    read: async () => await readSuspended(db),
    log: silent,
    now: () => at,
  });
  const metrics = serverMetrics();
  const app = createApp(
    testDependencies({ database: db, clock, composition: run(suspension), metrics }),
  );
  return {
    suspension,
    metrics,
    advance: (ms): void => {
      at += ms;
    },
    call: async (method, path, who, body): Promise<Answer> => {
      const response = await app.handle(
        new Request(`${ORIGIN}${path}`, requestInit(method, who?.cookie ?? '', body)),
      );
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    },
  };
};

const withoutRequestId = (answer: Answer): string =>
  JSON.stringify(answer).replace(/"requestId":"[^"]*"/g, '"requestId":"-"');

const stop = async (db: Executor, module: string): Promise<void> => {
  await db
    .insertInto('suspended_modules')
    .values({ module, reason: 'misbehaving', source: 'test', suspended_at: NOW })
    .execute();
};

const aWorkspaceOf = async (
  node: ReturnType<typeof aNode>,
  owner: SignedInUser,
): Promise<string> => {
  const created = await node.call('POST', '/api/workspaces', owner, {
    name: 'Acme',
    slug: aUniqueSlug('acme'),
  });
  expect(created.status).toBe(201);
  return (created.body as { id: string }).id;
};

/** The documented endpoints of one module, with ids to cross them with. */
const endpointsOf = (
  module: BundledModule,
  workspaceId: string,
): readonly { key: string; method: string; path: string; body?: unknown }[] => {
  const fresh = (): string => crypto.randomUUID();
  const ids: Ids = {
    workspaceId,
    channelId: fresh(),
    messageId: fresh(),
    attachmentId: fresh(),
    unsentAttachmentId: fresh(),
    memberId: fresh(),
    invitationId: fresh(),
    recipientId: fresh(),
    feedId: fresh(),
    versionId: fresh(),
    incidentId: fresh(),
    bookmarkId: fresh(),
    issueId: fresh(),
    webhookId: fresh(),
    exportId: fresh(),
  };
  const owns = ownsPath(module.manifest.routes ?? []);
  return Object.entries(CROSS_TENANT).flatMap(([key, crossing]) => {
    const [method, template] = key.split(' ') as [string, string];
    const path = pathFor(template, ids);
    if (!owns(path)) return [];
    const owner = { replyId: fresh(), userId: fresh(), messageId: fresh(), workspaceId };
    return [{ key, method, path, body: crossing.body?.(NOW, owner) }];
  });
};

const issuesIn = async (db: Executor, workspaceId: string): Promise<number> =>
  Number(
    (
      await db
        .selectFrom('issues')
        .select((eb) => eb.fn.countAll().as('rows'))
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow()
    ).rows,
  );

describe('integration: every endpoint of a stopped module', () => {
  for (const module of bundledModules) {
    const id = module.manifest.id;
    const others = bundledModules.filter((one) => one !== module);

    test(`${id}: answers a member of any workspace, a stranger and a caller with no session as a process without ${id} does`, async () => {
      await withRollback(async (db) => {
        const node = aNode(db);
        const absent = aNode(db, () => compose(others, bundledModules));
        const owner = await aSignedInUser(db, clock, 'Owner');
        const stranger = await aSignedInUser(db, clock, 'Stranger');
        const first = await aWorkspaceOf(node, owner);
        const second = await aWorkspaceOf(node, owner);
        const aboutToBeStopped = endpointsOf(module, first);
        expect(aboutToBeStopped.length).toBeGreaterThanOrEqual(1);
        await stop(db, id);
        node.advance(SUSPENSION_TTL_MS);

        for (const workspaceId of [first, second]) {
          for (const { key, method, path, body } of endpointsOf(module, workspaceId)) {
            for (const who of [owner, stranger, null]) {
              const stopped = await node.call(method, path, who, body);
              const missing = await absent.call(method, path, who, body);
              expect({ key, answer: withoutRequestId(stopped) }).toEqual({
                key,
                answer: withoutRequestId(missing),
              });
              expect(stopped.status).toBe(404);
              expect(JSON.stringify(stopped.body)).toContain('ROUTE_NOT_FOUND');
            }
          }
        }
      });
    });
  }

  test('keep what the module made, and are served again when the stop is lifted', async () => {
    await withRollback(async (db) => {
      const node = aNode(db);
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(node, owner);
      const made = await node.call('POST', `/api/workspaces/${workspaceId}/issues`, owner, {
        title: 'Kept',
      });
      expect(made.status).toBe(201);

      await stop(db, 'issues');
      node.advance(SUSPENSION_TTL_MS);
      expect((await node.call('GET', `/api/workspaces/${workspaceId}/issues`, owner)).status).toBe(
        404,
      );
      expect(await issuesIn(db, workspaceId)).toBe(1);

      await db.deleteFrom('suspended_modules').where('module', '=', 'issues').execute();
      node.advance(SUSPENSION_TTL_MS);
      const back = await node.call('GET', `/api/workspaces/${workspaceId}/issues`, owner);
      expect(back.status).toBe(200);
      expect(JSON.stringify(back.body)).toContain('Kept');
    });
  });
});

describe('integration: a change reaches a node by itself, within the TTL', () => {
  test('is not believed before the TTL has passed, is after, and needs nobody to tell the node', async () => {
    await withRollback(async (db) => {
      const node = aNode(db);
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(node, owner);
      const path = `/api/workspaces/${workspaceId}/issues`;
      expect((await node.call('GET', path, owner)).status).toBe(200);

      // Written by another node, or by the command: this one is told by nothing but the table.
      await stop(db, 'issues');
      node.advance(SUSPENSION_TTL_MS - 1);
      expect((await node.call('GET', path, owner)).status).toBe(200);
      node.advance(1);
      expect((await node.call('GET', path, owner)).status).toBe(404);
    });
  });

  test('is one node’s view and no other’s state: a second node on the same table reads the same stop', async () => {
    await withRollback(async (db) => {
      const [one, two] = [aNode(db), aNode(db)];
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(one, owner);
      await stop(db, 'issues');
      one.advance(SUSPENSION_TTL_MS);
      two.advance(SUSPENSION_TTL_MS);
      const path = `/api/workspaces/${workspaceId}/issues`;
      expect((await one.call('GET', path, owner)).status).toBe(404);
      expect((await two.call('GET', path, owner)).status).toBe(404);
    });
  });
});

describe('integration: what a client is told while a module is stopped', () => {
  interface Listed {
    readonly workspace: { readonly id: string };
    readonly modules?: readonly string[];
  }

  test('is the session without it, per workspace and for the server, and the search says it is off', async () => {
    await withRollback(async (db) => {
      const node = aNode(db);
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(node, owner);
      const before = (await node.call('GET', '/api/me', owner)).body as {
        modules: string[];
        memberships: Listed[];
      };
      expect(before.modules).toContain('issues');

      await stop(db, 'issues');
      node.advance(SUSPENSION_TTL_MS);
      await node.suspension.fresh();
      const me = (await node.call('GET', '/api/me', owner)).body as typeof before;
      expect(me.modules).not.toContain('issues');
      expect(me.modules).toContain('chat');
      expect(me.memberships.find(({ workspace }) => workspace.id === workspaceId)?.modules).toEqual(
        ['chat'],
      );
      const listed = (await node.call('GET', '/api/workspaces', owner)).body as Listed[];
      expect(listed.find(({ workspace }) => workspace.id === workspaceId)?.modules).toEqual([
        'chat',
      ]);

      const found = await node.call('GET', `/api/workspaces/${workspaceId}/find?q=anything`, owner);
      expect(found.status).toBe(200);
      const skipped = (found.body as { skipped: { source: string; reason: string }[] }).skipped;
      for (const source of issuesModule.manifest.searchSources) {
        expect(skipped).toContainEqual({ source, reason: 'off' });
      }
    });
  });

  test('is the client capabilities without chat’s, while chat is stopped, and the metric says which is stopped', async () => {
    await withRollback(async (db) => {
      const node = aNode(db);
      const capabilities = async (): Promise<Record<string, boolean>> =>
        (
          (await node.call('GET', '/api/client', null)).body as {
            capabilities: Record<string, boolean>;
          }
        ).capabilities;
      expect((await capabilities())['scheduledMessages']).toBe(true);
      await stop(db, 'chat');
      node.advance(SUSPENSION_TTL_MS);
      await node.suspension.fresh();
      expect((await capabilities())['scheduledMessages']).toBe(false);
      const page = renderMetrics(node.metrics, [
        moduleSuspendedFamily(['chat', 'issues'], node.suspension.current()),
      ]);
      expect(page).toContain('purlay_module_suspended{module="chat"} 1');
      expect(page).toContain('purlay_module_suspended{module="issues"} 0');
    });
  });
});

describe('integration: the core goes on', () => {
  test('with every module stopped the session, the workspaces and the members are served', async () => {
    await withRollback(async (db) => {
      const node = aNode(db);
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(node, owner);
      for (const module of [chatModule, issuesModule]) await stop(db, module.manifest.id);
      node.advance(SUSPENSION_TTL_MS);
      expect((await node.call('GET', '/api/me', owner)).status).toBe(200);
      expect((await node.call('GET', `/api/workspaces/${workspaceId}/members`, owner)).status).toBe(
        200,
      );
      expect(
        ((await node.call('GET', '/api/me', owner)).body as { modules: string[] }).modules,
      ).toEqual([]);
    });
  });
});

describe('integration: what the application hands a module while it is stopped', () => {
  // Fake modules under the two ids the contract knows: the application only draws the ids it can name to a client.
  const base = {
    requires: [],
    optional: [],
    degrades: {},
    provides: [],
    budget: { none: 'a test module' },
    entitlement: 'always' as const,
  };
  const DROPPED = defineFact({
    type: 'issues.dropped',
    owner: 'issues',
    absent: 'drop',
    schema: Type.Object({ id: Type.String() }),
  });
  const HELD = defineFact({
    type: 'issues.held',
    owner: 'issues',
    absent: { holdDays: 3 },
    schema: Type.Object({ id: Type.String() }),
  });
  let handed: ModuleRouteDependencies | undefined;
  const publisher: BundledModule = {
    manifest: {
      ...base,
      id: 'issues',
      publishes: ['issues.dropped', 'issues.held'],
      notifications: [{ type: 'issue_made', needsYou: false, pushed: false, mailed: false }],
    },
    routes: (dependencies) => {
      handed = dependencies;
      return new Elysia();
    },
  };
  const consumer: BundledModule = {
    manifest: {
      ...base,
      id: 'chat',
      optional: ['issues'],
      degrades: { issues: 'it shows nothing of the issues' },
      consumes: ['issues.dropped', 'issues.held'],
    },
    factConsumers: {
      'issues.dropped': () => Promise.resolve('done'),
      'issues.held': () => Promise.resolve('done'),
    },
  };
  const aMember = async (db: Transaction): Promise<{ context: WorkspaceContext }> => {
    const workspaceId = await aWorkspaceRow(db);
    const { userId } = await aUserRow(db, 'Member');
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
      .execute();
    return { context: await requireWorkspaceMembership(db, userId, workspaceId) };
  };
  const appWithout = (db: Executor, stopped: string): void => {
    const suspension: Suspension = {
      current: () => new Set([stopped]),
      fresh: () => Promise.resolve(new Set([stopped])),
      replace: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    };
    const modules = [publisher, consumer];
    createApp(
      testDependencies({
        database: db,
        clock,
        composition: compose(modules, modules, 'open', [DROPPED, HELD], suspension),
      }),
    );
  };

  test('a notice of a stopped module is not written, and the same notice of a module that runs is', async () => {
    await withRollback(async (db) => {
      const { context } = await aMember(db);
      const { userId: recipientId } = await aUserRow(db, 'Recipient');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: context.workspaceId, user_id: recipientId, role: 'member' })
        .execute();
      const notice = {
        kind: 'issue_made',
        recipientId,
        subject: { type: 'issue', id: crypto.randomUUID() },
        params: {},
      };
      appWithout(db, 'chat');
      expect(await handed?.inbox.notify(db, context, notice)).toMatchObject({ recipientId });
      appWithout(db, 'issues');
      expect(await handed?.inbox.notify(db, context, notice)).toBeUndefined();
      const kept = await db
        .selectFrom('inbox_entries')
        .select('module')
        .where('workspace_id', '=', context.workspaceId)
        .execute();
      expect(kept).toEqual([{ module: 'issues' }]);
    });
  });

  test('a fact for a stopped consumer follows the fact’s own word: dropped, or held for the days it says', async () => {
    await withRollback(async (db) => {
      const { context } = await aMember(db);
      const { workspaceId } = context;
      appWithout(db, 'chat');
      await handed?.publishFact(db, context, DROPPED, { id: 'a' });
      const rows = (): Promise<{ consumer: string; type: string; state: string }[]> =>
        db
          .selectFrom('outbox')
          .select(['consumer', 'type', 'state'])
          .where('workspace_id', '=', workspaceId)
          .execute();
      expect(await rows()).toEqual([]);
      await handed?.publishFact(db, context, HELD, { id: 'a' });
      expect(await rows()).toEqual([{ consumer: 'chat', type: 'issues.held', state: 'pending' }]);
    });
  });
});
