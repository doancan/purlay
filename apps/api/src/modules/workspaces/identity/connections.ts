/** Provider configuration is sealed and revision-fenced; only an actual callback can mark it tested. */
import { isIP } from 'node:net';
import type { Database, Selectable, Transaction } from '@purlay/db';
import {
  COMPANY_CONNECTIONS_MAX,
  type CompanyIdentityConnection,
  type CompanyIdentityConnectionPage,
  type CreateCompanyConnectionRequest,
  type UpdateCompanyConnectionRequest,
} from '@purlay/types/workspace-identity';
import { AppError } from '../../../platform/errors';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import {
  identityChanged,
  identityInvalid,
  identityMissing,
  identityNotReady,
  lockCompanyIdentityActor,
  type CompanyIdentityActor,
  type CompanyIdentityDependencies,
} from './authority';

type ConnectionRow = Selectable<Database['workspace_identity_connections']>;
const connectionView = (row: ConnectionRow, domainVerified: boolean): CompanyIdentityConnection => {
  const ready =
    domainVerified &&
    row.deleted_at === null &&
    row.client_secret_encrypted !== null &&
    row.tested_authentication_revision !== null &&
    row.tested_authentication_revision === row.authentication_revision;
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    domainId: row.domain_id,
    issuer: row.issuer,
    clientId: row.client_id,
    enabled: row.enabled && ready,
    secretConfigured: row.client_secret_encrypted !== null,
    ready,
    testedAt: row.tested_at === null ? null : new Date(row.tested_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

const liveDomain = async (
  transaction: Transaction,
  workspaceId: string,
  id: string,
): Promise<void> => {
  const domain = await transaction
    .selectFrom('workspace_identity_domains')
    .select(['verified_at', 'revoked_at'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (domain?.revoked_at !== null) throw identityMissing();
  if (domain.verified_at === null)
    throw identityNotReady('Verify the company domain before configuring its sign-in provider.');
};

/** The transport also resolves and pins public addresses; saving a URL does not contact it. */
const validateIssuer = (issuer: string): void => {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw identityInvalid('issuer', 'Enter a public HTTPS issuer URL.');
  }
  if (
    /[\s\p{Cc}\p{Cf}]/u.test(issuer) ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname.includes('.') ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    url.hostname.endsWith('.localhost') ||
    issuer !== issuer.trim()
  )
    throw identityInvalid(
      'issuer',
      'Enter a public HTTPS issuer URL without credentials, query or fragment.',
    );
};

const uniqueName = async (
  transaction: Transaction,
  workspaceId: string,
  name: string,
  except?: string,
): Promise<void> => {
  let query = transaction
    .selectFrom('workspace_identity_connections')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .where('name', '=', name);
  if (except !== undefined) query = query.where('id', '!=', except);
  if ((await query.executeTakeFirst()) !== undefined)
    throw identityInvalid('name', 'This company sign-in name is already in use.');
};

const currentConnection = async (
  transaction: Transaction,
  workspaceId: string,
  id: string,
): Promise<ConnectionRow> => {
  const row = await transaction
    .selectFrom('workspace_identity_connections')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw identityMissing();
  return row;
};

const revokeProofs = async (
  transaction: Transaction,
  workspaceId: string,
  id: string,
  now: Date,
): Promise<void> => {
  await transaction
    .updateTable('workspace_identity_sessions')
    .set({ revoked_at: now })
    .where('workspace_id', '=', workspaceId)
    .where('connection_id', '=', id)
    .where('revoked_at', 'is', null)
    .execute();
};

export const listCompanyConnections = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
): Promise<CompanyIdentityConnectionPage> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const rows = await transaction
      .selectFrom('workspace_identity_connections as connection')
      .innerJoin('workspace_identity_domains as domain', (join) =>
        join
          .onRef('domain.id', '=', 'connection.domain_id')
          .onRef('domain.workspace_id', '=', 'connection.workspace_id'),
      )
      .selectAll('connection')
      .select([
        'domain.verified_at as domain_verified_at',
        'domain.revoked_at as domain_revoked_at',
      ])
      .where('connection.workspace_id', '=', context.workspaceId)
      .where('connection.deleted_at', 'is', null)
      .orderBy('connection.id')
      .limit(COMPANY_CONNECTIONS_MAX)
      .execute();
    return {
      data: rows.map((row) =>
        connectionView(row, row.domain_verified_at !== null && row.domain_revoked_at === null),
      ),
      nextCursor: null,
    };
  });

export const createCompanyConnection = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  input: CreateCompanyConnectionRequest,
): Promise<CompanyIdentityConnection> => {
  validateIssuer(input.issuer);
  const name = input.name.trim();
  if (name === '') throw identityInvalid('name', 'Enter a company sign-in name.');
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    await liveDomain(transaction, context.workspaceId, input.domainId);
    await uniqueName(transaction, context.workspaceId, name);
    const { count } = await transaction
      .selectFrom('workspace_identity_connections')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', context.workspaceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count) >= COMPANY_CONNECTIONS_MAX)
      throw new AppError({
        code: 'COMPANY_IDENTITY_LIMIT',
        message: 'Remove an unused company sign-in connection first.',
      });
    const id = crypto.randomUUID();
    const row = await transaction
      .insertInto('workspace_identity_connections')
      .values({
        id,
        workspace_id: context.workspaceId,
        domain_id: input.domainId,
        name,
        issuer: input.issuer,
        client_id: input.clientId,
        client_secret_encrypted: Buffer.from(
          await dependencies.cipher.seal(input.clientSecret, id),
        ),
        created_at: dependencies.clock.now(),
        updated_at: dependencies.clock.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.connection_created',
      targetType: 'integration',
      targetId: id,
    });
    return connectionView(row, true);
  });
};

export const updateCompanyConnection = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  input: UpdateCompanyConnectionRequest,
): Promise<CompanyIdentityConnection> => {
  if (input.issuer !== undefined) validateIssuer(input.issuer);
  if (input.name?.trim() === '') throw identityInvalid('name', 'Enter a company sign-in name.');
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const before = await currentConnection(transaction, context.workspaceId, id);
    if (before.revision !== input.revision) throw identityChanged();
    const domainId = input.domainId ?? before.domain_id;
    await liveDomain(transaction, context.workspaceId, domainId);
    const name = input.name?.trim() ?? before.name;
    await uniqueName(transaction, context.workspaceId, name, id);
    if (input.issuer !== undefined && input.issuer !== before.issuer) {
      const binding = await transaction
        .selectFrom('workspace_identity_bindings')
        .select('id')
        .where('workspace_id', '=', context.workspaceId)
        .where('connection_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (binding !== undefined)
        throw identityNotReady(
          'Create a new connection to change the issuer of linked company identities.',
        );
    }
    const authenticationChanged =
      domainId !== before.domain_id ||
      (input.issuer !== undefined && input.issuer !== before.issuer) ||
      (input.clientId !== undefined && input.clientId !== before.client_id) ||
      input.clientSecret !== undefined;
    const now = dependencies.clock.now();
    const row = await transaction
      .updateTable('workspace_identity_connections')
      .set({
        name,
        domain_id: domainId,
        issuer: input.issuer ?? before.issuer,
        client_id: input.clientId ?? before.client_id,
        ...(input.clientSecret === undefined
          ? {}
          : {
              client_secret_encrypted: Buffer.from(
                await dependencies.cipher.seal(input.clientSecret, id),
              ),
            }),
        revision: crypto.randomUUID(),
        updated_at: now,
        ...(authenticationChanged
          ? {
              authentication_revision: crypto.randomUUID(),
              tested_authentication_revision: null,
              tested_at: null,
              enabled: false,
            }
          : {}),
      })
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (authenticationChanged) await revokeProofs(transaction, context.workspaceId, id, now);
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.connection_updated',
      targetType: 'integration',
      targetId: id,
      metadata: { authenticationChanged: String(authenticationChanged) },
    });
    return connectionView(row, true);
  });
};

export const setCompanyConnectionEnabled = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  revision: string,
  enabled: boolean,
): Promise<CompanyIdentityConnection> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const before = await currentConnection(transaction, context.workspaceId, id);
    if (before.revision !== revision) throw identityChanged();
    const domain = await transaction
      .selectFrom('workspace_identity_domains')
      .select(['verified_at', 'revoked_at'])
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', before.domain_id)
      .executeTakeFirstOrThrow();
    const verified = domain.verified_at !== null && domain.revoked_at === null;
    if (enabled && !connectionView(before, verified).ready)
      throw identityNotReady(
        'Verify the domain and complete a real provider sign-in test before enabling this connection.',
      );
    if (before.enabled === enabled) return connectionView(before, verified);
    const now = dependencies.clock.now();
    const row = await transaction
      .updateTable('workspace_identity_connections')
      .set({ enabled, revision: crypto.randomUUID(), updated_at: now })
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (!enabled) await revokeProofs(transaction, context.workspaceId, id, now);
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      ...(enabled
        ? { action: 'identity.connection_enabled' as const }
        : { action: 'identity.connection_disabled' as const }),
      targetType: 'integration',
      targetId: id,
    });
    return connectionView(row, verified);
  });

export const deleteCompanyConnection = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  revision: string,
): Promise<void> => {
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const before = await transaction
      .selectFrom('workspace_identity_connections')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (before === undefined) throw identityMissing();
    if (before.deleted_at !== null) return;
    if (before.revision !== revision) throw identityChanged();
    const now = dependencies.clock.now();
    await transaction
      .updateTable('workspace_identity_connections')
      .set({
        enabled: false,
        client_secret_encrypted: null,
        deleted_at: now,
        authentication_revision: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        tested_authentication_revision: null,
        tested_at: null,
        updated_at: now,
      })
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .execute();
    await revokeProofs(transaction, context.workspaceId, id, now);
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.connection_deleted',
      targetType: 'integration',
      targetId: id,
    });
  });
};
