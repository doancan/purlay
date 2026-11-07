/**
 * A workspace is granted the modules it may use, and the framework's guard is what asks (D-289).
 *
 * Every endpoint of a module a workspace can be granted is crossed on a third axis beside the tenant's and the channel's
 * (`cross-tenant.integration.test.ts`): a member of a workspace that is not granted the module is told what a process that
 * does not run it tells, byte for byte, and nothing is written. A person who is not a member is told the workspace does not
 * exist whatever its grants are. The list is read from `CROSS_TENANT`, so a module's new endpoint is crossed without a test.
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import {
  bundledModules,
  compose,
  compositionFor,
  type BundledModule,
  type Composition,
} from '../../composition';
import { chatModule } from '../../features/chat/module';
import { fixedClock } from '../../platform/clock';
import { serverMetrics, renderMetrics } from '../../platform/metrics';
import { ownsPath } from '../../platform/module-kit/routes';
import { CROSS_TENANT, UNSCOPED, pathFor, requestInit, type Ids } from '../../testing/cross-tenant';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

const OPEN = compositionFor(undefined, 'open');
const MANAGED = compositionFor(undefined, 'managed');
/** A process that does not run issues: the answer a grant that is not given must equal. */
const WITHOUT_ISSUES = compose([chatModule], bundledModules);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const caller = (db: Executor, modules: Composition, metrics = serverMetrics()) => {
  const app = createApp(testDependencies({ database: db, clock, composition: modules, metrics }));
  return async (
    method: string,
    path: string,
    who: SignedInUser,
    body?: unknown,
  ): Promise<Answer> => {
    const response = await app.handle(
      new Request(`${ORIGIN}${path}`, requestInit(method, who.cookie, body)),
    );
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };
};

/** An answer with its request id taken out, which differs by request and by nothing else. */
const withoutRequestId = (answer: Answer): string =>
  JSON.stringify(answer).replace(/"requestId":"[^"]*"/g, '"requestId":"-"');

const aWorkspaceOf = async (db: Executor, owner: SignedInUser): Promise<string> => {
  const created = await caller(db, OPEN)('POST', '/api/workspaces', owner, {
    name: 'Acme',
    slug: aUniqueSlug('acme'),
  });
  expect(created.status).toBe(201);
  return (created.body as { id: string }).id;
};

const grant = async (
  db: Executor,
  workspaceId: string,
  module: string,
  state: 'on' | 'off',
  validUntil: 'forever' | 'past' | 'future' = 'forever',
): Promise<void> => {
  await db
    .insertInto('workspace_modules')
    .values({
      workspace_id: workspaceId,
      module,
      state,
      valid_until:
        validUntil === 'forever'
          ? null
          : sql<Date>`now() + ${validUntil === 'past' ? '-1 hour' : '1 hour'}::interval`,
      source: 'operator',
      changed_at: NOW,
    })
    .execute();
};

const carried: readonly BundledModule[] = bundledModules;
const grantable = carried.filter((module) => module.manifest.entitlement !== 'always');
const ownedByAGrant = ownsPath(grantable.flatMap((module) => module.manifest.routes ?? []));

/** The documented endpoints of the modules a workspace is granted, with the ids a crossing is made with. */
const crossings = (
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
  return Object.entries(CROSS_TENANT).flatMap(([key, crossing]) => {
    const [method, template] = key.split(' ') as [string, string];
    const path = pathFor(template, ids);
    if (!ownedByAGrant(path)) return [];
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

describe('integration: the endpoints of a module a workspace can be granted', () => {
  test('are found in the documented list, and there is at least one', () => {
    expect(grantable.map((module) => module.manifest.id)).toContain('issues');
    expect(crossings(crypto.randomUUID()).length).toBeGreaterThanOrEqual(4);
  });

  test('answer a member of a workspace without the grant as a process without the module does, and write nothing', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      const managed = caller(db, MANAGED);
      const without = caller(db, WITHOUT_ISSUES);
      // One issue made while the workspace could, so that a write refused has something to change and a read something to show.
      await grant(db, workspaceId, 'issues', 'on');
      const made = await caller(db, MANAGED)(
        'POST',
        `/api/workspaces/${workspaceId}/issues`,
        owner,
        { title: 'Seen' },
      );
      expect(made.status).toBe(201);
      await db.deleteFrom('workspace_modules').where('workspace_id', '=', workspaceId).execute();
      const before = await issuesIn(db, workspaceId);
      expect(before).toBe(1);

      for (const { key, method, path, body } of crossings(workspaceId)) {
        const refused = await managed(method, path, owner, body);
        const absent = await without(method, path, owner, body);
        expect({ key, answer: withoutRequestId(refused) }).toEqual({
          key,
          answer: withoutRequestId(absent),
        });
        expect(refused.status).toBe(404);
        expect(JSON.stringify(refused.body)).toContain('ROUTE_NOT_FOUND');
      }
      expect(await issuesIn(db, workspaceId)).toBe(before);
    });
  });

  test('are served once the grant is given, to that workspace alone', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const granted = await aWorkspaceOf(db, owner);
      const other = await aWorkspaceOf(db, owner);
      await grant(db, granted, 'issues', 'on');
      const managed = caller(db, MANAGED);
      expect((await managed('GET', `/api/workspaces/${granted}/issues`, owner)).status).toBe(200);
      // Another workspace's grant is not this one's, and the same person is a member of both.
      expect((await managed('GET', `/api/workspaces/${other}/issues`, owner)).status).toBe(404);
    });
  });

  test('stay open on an open server until a row closes them, and a closed row closes them for that workspace alone', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const closed = await aWorkspaceOf(db, owner);
      const untouched = await aWorkspaceOf(db, owner);
      await grant(db, closed, 'issues', 'off');
      const open = caller(db, OPEN);
      expect((await open('GET', `/api/workspaces/${closed}/issues`, owner)).status).toBe(404);
      expect((await open('GET', `/api/workspaces/${untouched}/issues`, owner)).status).toBe(200);
    });
  });

  test('read a grant at the database’s clock: one that has ended is no grant, and one that has not is', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const ended = await aWorkspaceOf(db, owner);
      const running = await aWorkspaceOf(db, owner);
      await grant(db, ended, 'issues', 'on', 'past');
      await grant(db, running, 'issues', 'on', 'future');
      const managed = caller(db, MANAGED);
      expect((await managed('GET', `/api/workspaces/${ended}/issues`, owner)).status).toBe(404);
      expect((await managed('GET', `/api/workspaces/${running}/issues`, owner)).status).toBe(200);
      // An ended `off` is no row either: on an open server the module is back.
      const reopened = await aWorkspaceOf(db, owner);
      await grant(db, reopened, 'issues', 'off', 'past');
      expect(
        (await caller(db, OPEN)('GET', `/api/workspaces/${reopened}/issues`, owner)).status,
      ).toBe(200);
    });
  });
});

describe('integration: a downgrade and a grant again', () => {
  test('hide what the workspace made and keep it whole, and the grant brings it back', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      await grant(db, workspaceId, 'issues', 'on');
      const managed = caller(db, MANAGED);
      const made = await managed('POST', `/api/workspaces/${workspaceId}/issues`, owner, {
        title: 'Kept',
      });
      expect(made.status).toBe(201);

      await db.deleteFrom('workspace_modules').where('workspace_id', '=', workspaceId).execute();
      expect((await managed('GET', `/api/workspaces/${workspaceId}/issues`, owner)).status).toBe(
        404,
      );
      // Nothing was deleted, here or by what the downgrade left running.
      expect(await issuesIn(db, workspaceId)).toBe(1);

      await grant(db, workspaceId, 'issues', 'on');
      const back = await managed('GET', `/api/workspaces/${workspaceId}/issues`, owner);
      expect(back.status).toBe(200);
      expect(JSON.stringify(back.body)).toContain('Kept');
    });
  });
});

describe('integration: what a person is told they may use', () => {
  interface Listed {
    readonly workspace: { readonly id: string };
    readonly modules?: readonly string[];
  }
  const modulesOf = (memberships: readonly Listed[], workspaceId: string): unknown =>
    memberships.find(({ workspace }) => workspace.id === workspaceId)?.modules;

  test('is each workspace’s own set in the person’s session, their list of workspaces and an accepted invitation', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const withIssues = await aWorkspaceOf(db, owner);
      const without = await aWorkspaceOf(db, owner);
      await grant(db, withIssues, 'issues', 'on');
      const managed = caller(db, MANAGED);

      const me = await managed('GET', '/api/me', owner);
      const { memberships, modules } = me.body as { memberships: Listed[]; modules: string[] };
      expect(modulesOf(memberships, withIssues)).toEqual(['chat', 'issues']);
      expect(modulesOf(memberships, without)).toEqual(['chat']);
      // What the server runs is the server's, whatever a workspace may use.
      expect(modules).toEqual(['chat', 'issues']);

      const listed = (await managed('GET', '/api/workspaces', owner)).body as Listed[];
      expect(modulesOf(listed, withIssues)).toEqual(['chat', 'issues']);
      expect(modulesOf(listed, without)).toEqual(['chat']);

      // Joining answers the membership with the same set, so a client does not draw a module the workspace lacks.
      const newcomer = await aSignedInUser(db, clock, 'Newcomer');
      const link = await managed('POST', `/api/workspaces/${without}/invitations`, owner);
      const { token } = link.body as { token: string };
      const joined = await managed('POST', '/api/invitations/accept', newcomer, { token });
      expect(joined.status).toBe(200);
      expect((joined.body as Listed).modules).toEqual(['chat']);
    });
  });

  test('is every module the server runs on an open server, and not what another workspace’s row says', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const closed = await aWorkspaceOf(db, owner);
      const untouched = await aWorkspaceOf(db, owner);
      await grant(db, closed, 'issues', 'off');
      const { memberships } = (await caller(db, OPEN)('GET', '/api/me', owner)).body as {
        memberships: Listed[];
      };
      expect(modulesOf(memberships, closed)).toEqual(['chat']);
      expect(modulesOf(memberships, untouched)).toEqual(['chat', 'issues']);
    });
  });

  test('leaves out a module the server does not run, whatever a row says', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      await grant(db, workspaceId, 'issues', 'on');
      await grant(db, workspaceId, 'tasks', 'on');
      const { memberships } = (await caller(db, WITHOUT_ISSUES)('GET', '/api/me', owner)).body as {
        memberships: Listed[];
      };
      expect(modulesOf(memberships, workspaceId)).toEqual(['chat']);
    });
  });
});

describe('integration: what is asked of several modules at once', () => {
  const noticeFor = async (db: Executor, workspaceId: string, userId: string): Promise<void> => {
    await db
      .insertInto('inbox_entries')
      .values({
        id: messageId(NOW),
        workspace_id: workspaceId,
        user_id: userId,
        module: 'issues',
        kind: 'issue_assigned',
        subject_type: 'issue',
        subject_id: crypto.randomUUID(),
        params: JSON.stringify({ title: 'Seen' }),
        created_at: NOW,
      })
      .execute();
  };
  interface Found {
    readonly groups: readonly { readonly source: string }[];
    readonly skipped: readonly { readonly source: string; readonly reason: string }[];
  }
  interface Inbox {
    readonly data: readonly unknown[];
    readonly unreadCount: number;
  }

  test('the find asks only the sources of modules the workspace may use, and says the others are off', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      const path = `/api/workspaces/${workspaceId}/find?q=seen`;
      const managed = caller(db, MANAGED);
      const refused = (await managed('GET', path, owner)).body as Found;
      expect(refused.groups.map(({ source }) => source)).not.toContain('issues');
      expect(refused.skipped).toContainEqual({ source: 'issues', reason: 'off' });
      await grant(db, workspaceId, 'issues', 'on');
      const granted = (await managed('GET', path, owner)).body as Found;
      expect(granted.groups.map(({ source }) => source)).toContain('issues');
      expect(granted.skipped.map(({ source }) => source)).not.toContain('issues');
    });
  });

  test('the inbox shows, counts and reads the notices of the modules the workspace may use, and keeps the rest', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      await noticeFor(db, workspaceId, owner.userId);
      const managed = caller(db, MANAGED);
      const inbox = `/api/workspaces/${workspaceId}/inbox`;

      const hidden = (await managed('GET', inbox, owner)).body as Inbox;
      expect([hidden.data.length, hidden.unreadCount]).toEqual([0, 0]);
      // Reading all of them reads none of the notices a workspace may not see.
      expect((await managed('POST', `${inbox}/read`, owner, { all: true })).status).toBe(204);
      const kept = await db
        .selectFrom('inbox_entries')
        .select('read_at')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      expect(kept.read_at).toBeNull();

      await grant(db, workspaceId, 'issues', 'on');
      const shown = (await managed('GET', inbox, owner)).body as Inbox;
      expect([shown.data.length, shown.unreadCount]).toEqual([1, 1]);
    });
  });
});

describe('integration: a route that finds its workspace without a membership', () => {
  test('is none of a module that is a grant: the guard is not what would turn it away', () => {
    // A signed webhook resolves its workspace from a token and mints no context, so the guard never sees it. When a module
    // that is a grant has one, it must ask the function itself and this list must say so; until then there is none.
    const unscopedOfAGrant = Object.keys(UNSCOPED).filter((key) =>
      ownedByAGrant(key.split(' ')[1]!.replace(/:\w+/g, 'x')),
    );
    expect(unscopedOfAGrant).toEqual([]);
  });
});

describe('integration: a person who is not a member', () => {
  test('is told the workspace does not exist, with a grant, without one and on either kind of server', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const stranger = await aSignedInUser(db, clock, 'Stranger');
      const workspaceId = await aWorkspaceOf(db, owner);
      const unknown = crypto.randomUUID();
      const answers: unknown[] = [];
      for (const modules of [OPEN, MANAGED]) {
        const asked = caller(db, modules);
        answers.push(
          withoutRequestId(await asked('GET', `/api/workspaces/${workspaceId}/issues`, stranger)),
          withoutRequestId(await asked('GET', `/api/workspaces/${unknown}/issues`, stranger)),
        );
      }
      await grant(db, workspaceId, 'issues', 'on');
      answers.push(
        withoutRequestId(
          await caller(db, MANAGED)('GET', `/api/workspaces/${workspaceId}/issues`, stranger),
        ),
      );
      for (const answer of answers) expect(answer).toEqual(answers[0]);
      expect(JSON.stringify(answers[0])).toContain('WORKSPACE_NOT_FOUND');
    });
  });
});

describe('integration: a module no workspace is granted', () => {
  test('is served on a managed server with no row: chat is not a grant', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      const channels = await caller(db, MANAGED)(
        'GET',
        `/api/workspaces/${workspaceId}/channels`,
        owner,
      );
      expect(channels.status).toBe(200);
    });
  });
});

describe('integration: a request turned away for a grant', () => {
  test('is counted under the module, and a served one is not', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'Owner');
      const workspaceId = await aWorkspaceOf(db, owner);
      const metrics = serverMetrics(undefined, ['chat', 'issues']);
      const asked = caller(db, MANAGED, metrics);
      const counted = (): string =>
        renderMetrics(metrics)
          .split('\n')
          .filter((line) => line.startsWith('purlay_entitlement_refusals_total{'))
          .join('\n');
      expect(counted()).toContain('purlay_entitlement_refusals_total{module="issues"} 0');
      await asked('GET', `/api/workspaces/${workspaceId}/issues`, owner);
      await asked('GET', `/api/workspaces/${workspaceId}/issues`, owner);
      await asked('GET', `/api/workspaces/${workspaceId}/channels`, owner);
      expect(counted()).toContain('purlay_entitlement_refusals_total{module="issues"} 2');
      expect(counted()).toContain('purlay_entitlement_refusals_total{module="chat"} 0');
    });
  });
});
