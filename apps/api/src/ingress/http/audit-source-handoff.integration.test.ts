/** The actual native source must survive every audit-page SQL-to-byte handoff. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { systemClock } from '../../platform/clock';
import { COMPANY_SESSION_COOKIE } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import { currentRequest } from '../../platform/logging';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import { AUDIT_EXPORT_PAGE } from '../../modules/audit/audit-export';
import { noWorkspaceChannels } from '../../modules/workspaces/channels-port';
import { unlinkCompanyIdentity } from '../../modules/workspaces/identity/bindings';
import { assignWorkspaceAccessGrant } from '../../modules/workspaces/provisioning/grants';
import { requireManualWorkspaceSource } from '../../modules/workspaces/provisioning/native-state';
import { createWorkspaceAccessRole } from '../../modules/workspaces/provisioning/roles';
import { lockWorkspaceProjectionScope } from '../../modules/workspaces/provisioning/scope';
import {
  enableCompanyNative,
  roundtripCompanyNative,
  setupCompanyNative,
  signInCompanyNative,
} from '../../testing/company-native-auth';
import { testDependencies } from '../../testing/doubles';
import { PUSH_QUIET_BUS } from '../../testing/pending-push';
import { createApp } from './app';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const grantAudit = async (
  configured: Awaited<ReturnType<typeof setupCompanyNative>>,
  userId: string,
): Promise<void> => {
  const dependencies = {
    ...configured.fixture.dependencies,
    channels: noWorkspaceChannels,
    bus: PUSH_QUIET_BUS,
    readersReady: (): Promise<boolean> => Promise.resolve(true),
  };
  const source = await clone.db.transaction().execute(async (transaction) => {
    const scope = await lockWorkspaceProjectionScope(
      transaction,
      configured.fixture.actor.context.workspaceId,
    );
    return await requireManualWorkspaceSource(transaction, systemClock, scope, userId);
  });
  const role = await createWorkspaceAccessRole(dependencies, configured.fixture.actor, {
    name: 'Audit readers',
    capabilities: ['audit.read'],
  });
  await assignWorkspaceAccessGrant(dependencies, configured.fixture.actor, {
    roleId: role.id,
    roleRevision: role.revision,
    subject: { kind: 'source', sourceId: source.id },
    subjectRevision: source.revision,
    scope: { kind: 'workspace' },
  });
};

describe('integration: source-bound audit export', () => {
  test('an awaited later audit page cannot borrow retained manual or B authority after its actual company-A proof is revoked', async () => {
    const a = await signInCompanyNative(clone.db);
    const userId = a.companySession.userId;
    const workspaceId = a.fixture.member.context.workspaceId;
    await grantAudit(a, userId);
    const b = await setupCompanyNative(clone.db);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: b.fixture.actor.context.workspaceId,
        user_id: userId,
        role: 'member',
      })
      .execute();
    const enabled = await enableCompanyNative(b);
    b.idp.person = { sub: 'independent-company-b', email: 'b-employee@company.example' };
    expect(
      (
        await roundtripCompanyNative(
          b,
          {
            workspaceId: b.fixture.actor.context.workspaceId,
            connectionId: b.connection.id,
            revision: enabled.revision,
            intent: 'link',
          },
          a.memberCookie,
        )
      ).status,
    ).toBe(302);
    const bWorkspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', b.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    const bLogin = await roundtripCompanyNative(
      b,
      { workspace: bWorkspace.slug, connectionId: b.connection.id },
      '',
      true,
    );
    expect(bLogin.status).toBe(302);
    const bCookie = bLogin.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (bCookie === undefined) throw new Error('Missing actual native company-B session.');
    await grantAudit(b, userId);

    // The action filter excludes setup/audit.exported rows, so the second page is exactly one row.
    const now = systemClock.now();
    await clone.db
      .insertInto('audit_log')
      .values(
        Array.from({ length: AUDIT_EXPORT_PAGE + 1 }, (_, index) => ({
          id: messageId(new Date(now.getTime() - index)),
          workspace_id: workspaceId,
          actor_user_id: userId,
          action: 'member.left' as const,
          target_type: 'user',
          target_id: userId,
          metadata: '{}',
          created_at: new Date(now.getTime() - index),
        })),
      )
      .execute();

    const selected = new Set<unknown>();
    const materialized = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let pages = 0;
    let heldRows = 0;
    let sourceSessionId: string | undefined;
    const database: Executor = clone.db.withPlugin({
      transformQuery: (args) => {
        if (args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes('audit_log'))
          selected.add(args.queryId);
        return args.node;
      },
      transformResult: async (args) => {
        if (selected.delete(args.queryId)) {
          pages += 1;
          if (pages === 2) {
            heldRows = args.result.rows.length;
            sourceSessionId = currentRequest()?.sessionId;
            materialized.resolve(undefined);
            await release.promise;
          }
        }
        return args.result;
      },
    });
    const app = createApp(testDependencies({ database, clock: systemClock, auth: a.auth }));
    const get = async (cookie: string, id: string, path = '/audit'): Promise<Response> =>
      await app.handle(
        new Request(`https://purlay.test/api/workspaces/${id}${path}`, { headers: { cookie } }),
      );
    const response = await get(
      a.cookie,
      workspaceId,
      '/audit/export?format=ndjson&action=member.left',
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing audit export stream.');
    const first = await reader.read();
    expect(first.done).toBe(false);
    const firstBytes: unknown = first.value;
    if (!(firstBytes instanceof Uint8Array)) throw new Error('Expected actual audit bytes.');
    expect(new TextDecoder().decode(firstBytes).trim().split('\n')).toHaveLength(AUDIT_EXPORT_PAGE);
    expect(pages).toBe(1);
    const later = reader.read().then(
      (page) => {
        const bytes: unknown = page.value;
        return { state: 'bytes', byteLength: bytes instanceof Uint8Array ? bytes.byteLength : 0 };
      },
      (error: unknown) => ({
        state: 'error',
        code: error instanceof AppError ? error.body.code : 'unexpected',
      }),
    );
    try {
      await materialized.promise;
      expect(heldRows).toBe(1);
      expect(sourceSessionId).toBe(a.companySession.sessionId);
      const binding = await clone.db
        .selectFrom('workspace_identity_bindings')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('connection_id', '=', a.connection.id)
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      await unlinkCompanyIdentity(
        a.fixture.dependencies,
        a.fixture.member,
        a.connection.id,
        binding.id,
      );
      expect(
        await sessionFromHeaders(a.auth, new Headers({ cookie: a.cookie }), {
          recordActivity: false,
        }),
      ).toBeUndefined();
      expect((await get(a.memberCookie, workspaceId)).status).toBe(200);
      expect((await get(bCookie, b.fixture.actor.context.workspaceId)).status).toBe(200);
      expect(
        await clone.db
          .selectFrom('workspace_members')
          .select(['role', 'access_kind'])
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', userId)
          .executeTakeFirst(),
      ).toEqual({ role: 'member', access_kind: 'member' });
    } finally {
      release.resolve(undefined);
    }
    expect(await later).toEqual({ state: 'error', code: 'WORKSPACE_NOT_FOUND' });
    expect(pages).toBe(4); // Two export pages and the independent-A/company-B positive controls.
  });
});
