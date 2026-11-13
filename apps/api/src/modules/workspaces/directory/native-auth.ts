/** The pinned native SCIM handler joins a verified principal's prelocked native transaction. */
import type { BetterAuthPlugin, betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import type {
  SCIMIdentityResolution,
  SCIMProjectedUserState,
  SCIMTransactionContext,
} from '@better-auth/scim';
import { liveCompanySessionProof } from '../../../platform/company-session';
import { sql, type Executor, type Transaction } from '@purlay/db';
import { normalisedMailbox } from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import { type EventBus } from '../../../platform/events';
import { AppError } from '../../../platform/errors';
import type { Logger } from '../../../platform/logging';
import { noWorkspaceChannels, type WorkspaceChannels } from '../channels-port';
import { lockWorkspaceProjectionScope, workspaceAccessOutcome } from '../provisioning/scope';
import { publishWorkspaceAccessOutcome } from '../provisioning/administration';
import {
  reconcileDirectoryAccessGroup,
  retireDirectoryAccessGroup,
} from '../provisioning/directory-groups';
import {
  reconcileDirectoryWorkspaceSource,
  retireDirectoryWorkspaceSource,
} from '../provisioning/directory-sources';
import { directoryScimSchema } from './scim-schema';
import { nativeDirectoryTransactions, type ActiveDirectoryTransaction } from './native-transaction';
import { verifyDirectoryToken, type VerifiedDirectoryCredential } from './credentials';

export interface DirectoryNativeDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly channels?: WorkspaceChannels;
  readonly log?: Logger;
  readonly readersReady?: () => Promise<boolean>;
}
interface NativeDirectoryComposition {
  readonly plugin: BetterAuthPlugin;
  readonly initialize: (instance: ReturnType<typeof betterAuth>, after: Promise<unknown>) => void;
  readonly around: (request: Request, body: () => Promise<Response>) => Promise<Response>;
  readonly executor: () => Transaction | undefined;
  readonly consumeAdmission: (email: string) => Promise<boolean>;
  readonly denyGlobalProfileWrite: () => void;
}
interface ResourceIdentity {
  readonly id: string;
  readonly externalId: string | null;
  readonly userId: string;
}
const forbidden = (): APIError =>
  new APIError('FORBIDDEN', {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: '403',
    detail: 'An exact authorized directory identity is required.',
  });
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
export const workspaceDirectoryNative = (
  deps: DirectoryNativeDependencies,
): NativeDirectoryComposition => {
  let context: Awaited<ReturnType<typeof betterAuth>['$context']> | undefined;
  const targets = new WeakMap<ActiveDirectoryTransaction, ResourceIdentity>();
  const changes = { clock: deps.clock, channels: deps.channels ?? noWorkspaceChannels };
  const ready = async (): Promise<boolean> => {
    try {
      return (await deps.readersReady?.()) === true;
    } catch {
      return false;
    }
  };
  const prelock = async (
    tx: Transaction,
    presented: VerifiedDirectoryCredential,
  ): Promise<{
    readonly scope: Awaited<ReturnType<typeof lockWorkspaceProjectionScope>>;
    readonly credential: VerifiedDirectoryCredential;
  }> => {
    const scope = await lockWorkspaceProjectionScope(tx, presented.directory.workspace_id);
    const credential = await tx
      .selectFrom('workspace_directory_credentials')
      .selectAll()
      .where('id', '=', presented.credentialId)
      .where('workspace_id', '=', scope.workspaceId)
      .where('directory_id', '=', presented.directory.id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', deps.clock.now())
      .executeTakeFirst();
    const directory = await tx
      .selectFrom('workspace_directories')
      .selectAll()
      .where('id', '=', presented.directory.id)
      .where('workspace_id', '=', scope.workspaceId)
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (
      credential === undefined ||
      directory?.authorization_revision !== presented.directory.authorization_revision
    )
      throw forbidden();
    const connection = await tx
      .selectFrom('workspace_identity_connections')
      .select('id')
      .where('workspace_id', '=', scope.workspaceId)
      .where('id', '=', directory.connection_id)
      .where('directory_id', '=', directory.id)
      .where('directory_claim', '=', directory.claim)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (connection === undefined) throw forbidden();
    const now = deps.clock.now();
    if (
      credential.last_used_at === null ||
      now.getTime() - new Date(credential.last_used_at).getTime() >= 300_000
    )
      await tx
        .updateTable('workspace_directory_credentials')
        .set({ last_used_at: now })
        .where('id', '=', credential.id)
        .where('workspace_id', '=', scope.workspaceId)
        .execute();
    return {
      scope,
      credential: {
        credentialId: credential.id,
        directory,
        expiresAt: new Date(credential.expires_at),
      },
    };
  };
  const transactions = nativeDirectoryTransactions(
    deps.database,
    async (current, request) => {
      const path = new URL(request.url).pathname;
      const userPath = /\/scim\/v2\/Users(?:\/([^/]+))?$/.exec(path);
      if (userPath === null) return;
      let resource: ResourceIdentity | null = null;
      let externalId: string | undefined;
      let body: Readonly<Record<string, unknown>> | undefined;
      if (request.method === 'POST' && userPath[1] === undefined) {
        body = record(
          await request
            .clone()
            .json()
            .catch(() => null),
        );
        const ext = body?.['externalId'];
        if (typeof ext !== 'string' || ext.length === 0 || ext.length > 255) throw forbidden();
        externalId = ext;
      } else if (userPath[1] !== undefined) {
        resource = await current.adapter.findOne<ResourceIdentity>({
          model: 'scimUser',
          where: [
            { field: 'id', value: userPath[1] },
            { field: 'connectionId', value: current.credential.directory.id },
          ],
        });
        if (resource !== null) {
          targets.set(current, resource);
          externalId = resource.externalId ?? undefined;
        }
      }
      if (externalId === undefined) return;
      const tombstone = await current.adapter.findOne<{ profile: string }>({
        model: 'scimIdentityTombstone',
        where: [
          { field: 'connectionId', value: current.credential.directory.id },
          { field: 'externalId', value: externalId },
        ],
      });
      if (tombstone?.profile === 'manage') throw forbidden();
      let link = await current.transaction
        .selectFrom('workspace_directory_identity_links')
        .select(['user_id'])
        .where('workspace_id', '=', current.scope.workspaceId)
        .where('directory_id', '=', current.credential.directory.id)
        .where('external_id', '=', externalId)
        .executeTakeFirst();
      if (link === undefined && body !== undefined) {
        if (!current.credential.directory.allow_create || context === undefined) throw forbidden();
        const typed = body['userName'];
        const email = typeof typed === 'string' ? normalisedMailbox(typed) : undefined;
        if (email === undefined) throw forbidden();
        const display = body['displayName'];
        const name =
          typeof display === 'string' && display.trim().length > 0
            ? display.trim()
            : (email.split('@')[0] ?? 'Employee');
        const user = await transactions.initializeUser(
          email,
          async () =>
            await context?.internalAdapter.createUser(
              { email, name, emailVerified: false },
              { method: 'scim' },
            ),
        );
        if (user === undefined) throw forbidden();
        await current.transaction
          .insertInto('workspace_directory_identity_links')
          .values({
            workspace_id: current.scope.workspaceId,
            directory_id: current.credential.directory.id,
            user_id: user.id,
            external_id: externalId,
            origin: 'directory_created',
            created_at: deps.clock.now(),
          })
          .execute();
        link = { user_id: user.id };
      }
      if (link === undefined) throw forbidden();
      const subject = await current.adapter.findOne<{ profileSourceId: string | null }>({
        model: 'scimSubject',
        where: [{ field: 'userId', value: link.user_id }],
      });
      if (subject?.profileSourceId != null) throw forbidden();
    },
    prelock,
    async (current, request, response): Promise<void> => {
      const groupPath = /\/scim\/v2\/Groups(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
      if (groupPath !== null && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const returned = record(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        const groupId = groupPath[1] ?? returned?.['id'];
        if (typeof groupId !== 'string') throw forbidden();
        if (request.method === 'DELETE')
          await transactions.child(current.adapter, async (): Promise<void> => {
            await retireDirectoryAccessGroup(current.transaction, changes, current.scope, {
              directoryId: current.credential.directory.id,
              directoryGroupReference: groupId,
            });
          });
        else {
          const group = await current.transaction
            .selectFrom('workspace_directory_scim_groups')
            .select(['id', 'display_name'])
            .where('id', '=', groupId)
            .where('connection_id', '=', current.credential.directory.id)
            .where('provisioning_domain_id', '=', current.scope.workspaceId)
            .executeTakeFirst();
          if (group === undefined) throw forbidden();
          if (group.display_name.trim().length === 0 || group.display_name.length > 64)
            throw new AppError({
              code: 'VALIDATION_FAILED',
              message: 'Directory group names must contain at most 64 characters.',
              details: { fields: { displayName: 'Use a group name of at most 64 characters.' } },
            });
          const members = await current.transaction
            .selectFrom('workspace_directory_scim_group_members as membership')
            .innerJoin(
              'workspace_directory_scim_users as resource',
              'resource.id',
              'membership.scim_user_id',
            )
            .innerJoin('workspace_access_sources as source', (join) =>
              join
                .onRef('source.user_id', '=', 'resource.user_id')
                .onRef('source.directory_link_reference', '=', 'resource.id'),
            )
            .select('source.id')
            .where('membership.group_id', '=', group.id)
            .where('membership.connection_id', '=', current.credential.directory.id)
            .where('resource.connection_id', '=', current.credential.directory.id)
            .where('resource.provisioning_domain_id', '=', current.scope.workspaceId)
            .where('source.workspace_id', '=', current.scope.workspaceId)
            .where('source.directory_id', '=', current.credential.directory.id)
            .where('source.kind', '=', 'directory')
            .where('source.state', '!=', 'retired')
            .execute();
          await transactions.child(current.adapter, async (): Promise<void> => {
            await reconcileDirectoryAccessGroup(current.transaction, changes, current.scope, {
              directoryId: current.credential.directory.id,
              directoryGroupReference: group.id,
              name: group.display_name,
              sourceIds: members.map((row) => row.id),
              active: true,
            });
          });
        }
      }
      const outcome = workspaceAccessOutcome(current.transaction, current.scope);
      if (!outcome.changed) return;
      const administrators = await current.transaction
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', current.scope.workspaceId)
        .where('role', 'in', ['owner', 'admin'])
        .where('access_kind', '=', 'member')
        .execute();
      const ended =
        outcome.userIds.length === 0
          ? []
          : await current.transaction
              .selectFrom('workspace_identity_sessions as proof')
              .innerJoin('sessions as native', 'native.id', 'proof.session_id')
              .select('proof.session_id')
              .where('proof.workspace_id', '=', current.scope.workspaceId)
              .where('proof.directory_id', '=', current.credential.directory.id)
              .where('native.user_id', 'in', outcome.userIds)
              .where(
                sql<boolean>`not ${liveCompanySessionProof(sql.ref<string>('native.id'), sql.ref<string>('proof.workspace_id'), sql.ref<string>('native.user_id'))}`,
              )
              .execute();
      const finished = Object.freeze({
        ...outcome,
        endedCompanySessionIds: Object.freeze([
          ...new Set([...outcome.endedCompanySessionIds, ...ended.map((row) => row.session_id)]),
        ]),
      });
      const recipients = Object.freeze([
        ...new Set([...administrators.map((row) => row.user_id), ...outcome.userIds]),
      ]);
      const publisher = {
        bus: deps.bus,
        clock: deps.clock,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      };
      transactions.afterCommit(async (): Promise<void> => {
        await publishWorkspaceAccessOutcome(publisher, finished, recipients);
      });
    },
    (error): Response => {
      deps.log?.error('The native directory operation failed.', { err: error });
      const status = error instanceof AppError ? error.status : 500;
      return Response.json(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          status: String(status),
          ...(status === 400 ? { scimType: 'invalidValue' } : {}),
          detail:
            error instanceof AppError
              ? error.body.message
              : 'The directory operation could not be completed.',
        },
        { status, headers: { 'content-type': 'application/scim+json' } },
      );
    },
  );
  const project = async (
    input: SCIMProjectedUserState,
    native: SCIMTransactionContext,
  ): Promise<void> => {
    await transactions.child(native.database, async (current) => {
      if (input.provisioningDomainId !== current.scope.workspaceId) throw forbidden();
      const source = input.sources.find((s) => s.connectionId === current.credential.directory.id);
      if (source !== undefined) {
        await reconcileDirectoryWorkspaceSource(current.transaction, changes, current.scope, {
          directoryId: current.credential.directory.id,
          directoryLinkReference: source.id,
          userId: input.userId,
          active: source.active,
          name: current.credential.directory.name,
        });
      } else {
        const target = targets.get(current);
        if (target?.userId !== input.userId) throw forbidden();
        await retireDirectoryWorkspaceSource(current.transaction, changes, current.scope, {
          directoryId: current.credential.directory.id,
          directoryLinkReference: target.id,
          userId: input.userId,
        });
      }
    });
  };
  const plugin = directoryScimSchema({
    connections: [],
    authentication: {
      verifyBearerToken: async (input) => {
        if (!(await ready())) return null;
        const verified = await verifyDirectoryToken(deps.database, deps.clock, input.token);
        if (verified === null) return null;
        const current = await transactions.begin(verified);
        return {
          connection: {
            id: current.credential.directory.id,
            provisioningDomainId: current.scope.workspaceId,
          },
          credentialId: current.credential.credentialId,
          scopes: ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'],
          expiresAt: current.credential.expiresAt,
        };
      },
    },
    identity: {
      resolveUser: async (input): Promise<SCIMIdentityResolution> => {
        const current = transactions.current();
        if (
          input.connectionId !== current.credential.directory.id ||
          input.provisioningDomainId !== current.scope.workspaceId ||
          input.resource.externalId === undefined
        )
          throw forbidden();
        const link = await current.transaction
          .selectFrom('workspace_directory_identity_links')
          .select('user_id')
          .where('workspace_id', '=', current.scope.workspaceId)
          .where('directory_id', '=', current.credential.directory.id)
          .where('external_id', '=', input.resource.externalId)
          .executeTakeFirst();
        if (link === undefined) throw forbidden();
        return { action: 'link', userId: link.user_id, profile: 'preserve' };
      },
      reconcileUser: async (input, native) => {
        await transactions.child(native.database, (current): Promise<void> => {
          if (input.profileSourceId !== undefined) throw forbidden();
          if (
            !input.sources.every(
              (s) =>
                s.connectionId !== current.credential.directory.id ||
                s.provisioningDomainId === current.scope.workspaceId,
            )
          )
            throw forbidden();
          return Promise.resolve();
        });
        if (!input.active) transactions.expectInactiveDelete(native.database, input.userId);
      },
    },
    projection: { reconcileUser: project },
  });
  return {
    plugin:
      deps.readersReady === undefined
        ? { id: 'purlay-directory-schema', schema: plugin.schema }
        : plugin,
    around: transactions.around,
    executor: transactions.executor,
    consumeAdmission: transactions.consumeAdmission,
    denyGlobalProfileWrite: transactions.denyGlobalProfileWrite,
    initialize: (instance, after): void => {
      const composed = after.then(async () => {
        context = await instance.$context;
      });
      transactions.initialize(instance, composed);
    },
  };
};
