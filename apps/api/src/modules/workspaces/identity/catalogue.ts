/** A private snapshot for one OAuth round; current catalogue authority is read again under the workspace lock. */
import type { Executor } from '@purlay/db';
import {
  COMPANY_CONNECTIONS_MAX,
  type CompanyIdentityFlowState,
  type CompanySignInOptions,
} from '@purlay/types/workspace-identity';
import type { OidcCredentials } from '../../auth/oidc';
import {
  identityChanged,
  identityMissing,
  identityNotReady,
  type CompanyIdentityDependencies,
} from './authority';

export const COMPANY_PROVIDER_PREFIX = 'workspace-oidc:';
export const companyProviderId = (connectionId: string): string =>
  `${COMPANY_PROVIDER_PREFIX}${connectionId}`;

export interface CompanyConnectionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly revision: string;
  readonly authenticationRevision: string;
  readonly credentials: OidcCredentials;
}

/** Exact workspace address only: no public workspace directory, private issuer or credential inventory. */
export const companySignInOptions = async (
  executor: Executor,
  slug: string,
): Promise<CompanySignInOptions> => {
  const rows = await executor
    .selectFrom('workspace_identity_connections as connection')
    .innerJoin('workspace_identity_domains as domain', 'domain.id', 'connection.domain_id')
    .innerJoin('workspaces as workspace', 'workspace.id', 'connection.workspace_id')
    .select(['connection.id', 'connection.name'])
    .where('workspace.slug', '=', slug)
    .whereRef('domain.workspace_id', '=', 'connection.workspace_id')
    .where('workspace.deleted_at', 'is', null)
    .where('connection.deleted_at', 'is', null)
    .where('domain.revoked_at', 'is', null)
    .where('domain.verified_at', 'is not', null)
    .where('connection.client_secret_encrypted', 'is not', null)
    .where('connection.enabled', '=', true)
    .whereRef(
      'connection.tested_authentication_revision',
      '=',
      'connection.authentication_revision',
    )
    .orderBy('connection.id')
    .limit(COMPANY_CONNECTIONS_MAX)
    .execute();
  return { workspace: slug, connections: rows };
};

export const companyConnectionSnapshot = async (
  executor: Executor,
  dependencies: Pick<CompanyIdentityDependencies, 'cipher'>,
  connectionId: string,
  scope: { readonly workspaceId: string } | { readonly slug: string },
  enabled: boolean,
): Promise<CompanyConnectionSnapshot> => {
  let query = executor
    .selectFrom('workspace_identity_connections as connection')
    .innerJoin('workspace_identity_domains as domain', (join) =>
      join
        .onRef('domain.id', '=', 'connection.domain_id')
        .onRef('domain.workspace_id', '=', 'connection.workspace_id'),
    )
    .innerJoin('workspaces as workspace', 'workspace.id', 'connection.workspace_id')
    .selectAll('connection')
    .select([
      'workspace.slug',
      'domain.verified_at as domain_verified_at',
      'domain.revoked_at as domain_revoked_at',
    ])
    .where('connection.id', '=', connectionId)
    .where('connection.deleted_at', 'is', null)
    .where('workspace.deleted_at', 'is', null);
  query =
    'workspaceId' in scope
      ? query.where('connection.workspace_id', '=', scope.workspaceId)
      : query.where('workspace.slug', '=', scope.slug);
  const row = await query.executeTakeFirst();
  if (row === undefined) throw identityMissing();
  if (
    row.domain_verified_at === null ||
    row.domain_revoked_at !== null ||
    row.client_secret_encrypted === null
  )
    throw identityNotReady('This company sign-in domain is not verified.');
  if (
    enabled &&
    (!row.enabled ||
      row.tested_authentication_revision === null ||
      row.tested_authentication_revision !== row.authentication_revision)
  )
    throw identityNotReady('This company sign-in connection is not enabled and tested.');
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    revision: row.revision,
    authenticationRevision: row.authentication_revision,
    credentials: {
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: await dependencies.cipher.open(row.client_secret_encrypted, row.id),
    },
  };
};

export const matchCompanyIdentityFlow = (
  snapshot: CompanyConnectionSnapshot,
  flow: CompanyIdentityFlowState,
): void => {
  if (
    snapshot.id !== flow.connectionId ||
    snapshot.workspaceId !== flow.workspaceId ||
    snapshot.revision !== flow.revision ||
    snapshot.authenticationRevision !== flow.authenticationRevision
  )
    throw identityChanged();
};
