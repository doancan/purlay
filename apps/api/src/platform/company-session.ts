/** Current company authority, shared by session resolution and canonical resource guards (D-309). */
import { sql, type RawBuilder } from '@purlay/db';

/** The alias is chosen by the query owner; no source-bearing session can stand for another workspace. */
export const companySessionAllowsWorkspace = (
  alias: string,
  workspaceId: string | RawBuilder<string>,
): RawBuilder<boolean> => sql<boolean>`(
  ${sql.ref(`${alias}.company_workspace_id`)} is null or (
    ${sql.ref(`${alias}.company_workspace_id`)} = ${workspaceId}
    and ${liveCompanySessionProof(sql.ref<string>(`${alias}.id`), workspaceId, sql.ref<string>(`${alias}.user_id`))}
  )
)`;

/** A retained origin is authority only while its exact provider, binding and native membership remain live. */
export const liveCompanySessionProof = (
  sessionId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  userId: string | RawBuilder<string>,
  connectionId?: string | RawBuilder<string>,
): RawBuilder<boolean> => sql<boolean>`exists (
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
  join workspace_members as company_member
    on company_member.workspace_id = company_proof.workspace_id
    and company_member.user_id = company_binding.user_id
  join users as company_person on company_person.id = company_binding.user_id
  join workspaces as company_workspace on company_workspace.id = company_proof.workspace_id
  where company_proof.session_id = ${sessionId}
    and company_proof.workspace_id = ${workspaceId}
    and ${connectionId === undefined ? sql<boolean>`true` : sql<boolean>`company_proof.connection_id = ${connectionId}`}
    and company_binding.user_id = ${userId}
    and company_proof.revoked_at is null
    and company_connection.enabled
    and company_connection.deleted_at is null
    and company_connection.authentication_revision = company_proof.authentication_revision
    and company_connection.tested_authentication_revision = company_connection.authentication_revision
    and company_domain.verified_at is not null
    and company_domain.revoked_at is null
    and company_member.access_kind = 'member'
    and company_person.deleted_at is null
    and company_person.suspended_at is null
    and company_person.admission_state = 'approved'
    and (not company_person.admission_requires_verified_email or company_person.email_verified)
    and company_workspace.deleted_at is null
)`;
