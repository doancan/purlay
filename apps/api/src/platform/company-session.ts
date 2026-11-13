/** Current company authority, shared by session resolution and canonical resource guards (D-309). */
import { sql, type RawBuilder } from '@purlay/db';

interface CompanyProofCompanions {
  readonly member: string;
  readonly person: string;
  readonly workspace: string;
}

/** The alias is chosen by the query owner; no source-bearing session can stand for another workspace. */
export const companySessionAllowsWorkspace = (
  alias: string,
  workspaceId: string | RawBuilder<string>,
  companions?: CompanyProofCompanions,
): RawBuilder<boolean> => sql<boolean>`(
  ${sql.ref(`${alias}.company_workspace_id`)} is null or (
    ${sql.ref(`${alias}.company_workspace_id`)} = ${workspaceId}
    and ${liveCompanySessionProof(sql.ref<string>(`${alias}.id`), workspaceId, sql.ref<string>(`${alias}.user_id`), undefined, companions)}
  )
)`;

/** A retained origin is authority only while its exact provider, binding and native membership remain live. */
export const liveCompanySessionProof = (
  sessionId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  userId: string | RawBuilder<string>,
  connectionId?: string | RawBuilder<string>,
  companions?: CompanyProofCompanions,
): RawBuilder<boolean> => {
  const member = companions?.member ?? 'company_member';
  const person = companions?.person ?? 'company_person';
  const workspace = companions?.workspace ?? 'company_workspace';
  return sql<boolean>`exists (
  select 1
  from workspace_identity_sessions as company_proof
  join workspace_identity_connections as company_connection
    on company_connection.workspace_id = company_proof.workspace_id
    and company_connection.id = company_proof.connection_id
  join workspace_identity_domains as company_domain
    on company_domain.workspace_id = company_connection.workspace_id
    and company_domain.id = company_connection.domain_id
  join workspace_identity_bindings as company_binding
    on company_binding.workspace_id = company_proof.workspace_id
    and company_binding.connection_id = company_proof.connection_id
    and company_binding.id = company_proof.binding_reference
    and company_binding.issuer = company_connection.issuer
  ${
    companions === undefined
      ? sql`  join workspace_members as company_member
    on company_member.workspace_id = company_proof.workspace_id
    and company_member.user_id = company_binding.user_id
  join users as company_person on company_person.id = company_binding.user_id
  join workspaces as company_workspace on company_workspace.id = company_proof.workspace_id
`
      : sql``
  }
  where company_proof.session_id = ${sessionId}
    and company_proof.workspace_id = ${workspaceId}
    and ${connectionId === undefined ? sql<boolean>`true` : sql<boolean>`company_proof.connection_id = ${connectionId}`}
    and company_binding.user_id = ${userId}
    and ${sql.ref(`${member}.workspace_id`)} = company_proof.workspace_id
    and ${sql.ref(`${member}.user_id`)} = company_binding.user_id
    and ${sql.ref(`${person}.id`)} = company_binding.user_id
    and ${sql.ref(`${workspace}.id`)} = company_proof.workspace_id
    and company_proof.revoked_at is null
    and company_connection.enabled
    and company_connection.deleted_at is null
    and company_connection.authentication_revision = company_proof.authentication_revision
    and company_connection.tested_authentication_revision = company_connection.authentication_revision
    and company_domain.verified_at is not null
    and company_domain.revoked_at is null
    and ${sql.ref(`${member}.access_kind`)} = 'member'
    and ${sql.ref(`${person}.deleted_at`)} is null
    and ${sql.ref(`${person}.suspended_at`)} is null
    and ${sql.ref(`${person}.admission_state`)} = 'approved'
    and (not ${sql.ref(`${person}.admission_requires_verified_email`)} or ${sql.ref(`${person}.email_verified`)})
    and ${sql.ref(`${workspace}.deleted_at`)} is null
)`;
};
