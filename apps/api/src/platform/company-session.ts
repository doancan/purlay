/** Current company authority, shared by session resolution and canonical resource guards (D-309). */
import { sql, type AliasableExpression, type RawBuilder } from '@purlay/db';

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
const canonicalLiveCompanySessionProof = (
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

const COMPANY_PROOF_BATCH_NAME = 'ready_company_proofs';
interface CompanyProofBatchRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly connection_id: string;
  readonly user_id: string;
}
let companyProofBatch = false;

/** Outside synchronous final-batch construction, every caller retains the full canonical SQL proof. */
export const liveCompanySessionProof = (
  sessionId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  userId: string | RawBuilder<string>,
  connectionId?: string | RawBuilder<string>,
  companions?: CompanyProofCompanions,
): RawBuilder<boolean> => {
  if (!companyProofBatch)
    return canonicalLiveCompanySessionProof(
      sessionId,
      workspaceId,
      userId,
      connectionId,
      companions,
    );
  return sql<boolean>`exists (
    select 1 from ${sql.table(COMPANY_PROOF_BATCH_NAME)} as ready_company_proof
    where ready_company_proof.session_id = ${sessionId}
      and ready_company_proof.workspace_id = ${workspaceId}
      and ready_company_proof.user_id = ${userId}
      and ${connectionId === undefined ? sql<boolean>`true` : sql<boolean>`ready_company_proof.connection_id = ${connectionId}`}
      and ${
        companions === undefined
          ? sql<boolean>`true`
          : sql<boolean>`(
        ${sql.ref(`${companions.member}.workspace_id`)} = ready_company_proof.workspace_id
        and ${sql.ref(`${companions.member}.user_id`)} = ready_company_proof.user_id
        and ${sql.ref(`${companions.person}.id`)} = ready_company_proof.user_id
        and ${sql.ref(`${companions.workspace}.id`)} = ready_company_proof.workspace_id
      )`
      }
  )`;
};

/** Only synchronous query construction can refer to this statement's canonical proof relation. */
export const buildCompanyProofBatch = <Row>(
  sessionIds: readonly string[],
  build: () => readonly AliasableExpression<Row>[],
): {
  readonly name: typeof COMPANY_PROOF_BATCH_NAME;
  readonly source: RawBuilder<CompanyProofBatchRow>;
  readonly queries: readonly AliasableExpression<Row>[];
} => {
  if (companyProofBatch) throw new Error('Company proof batches cannot be nested');
  companyProofBatch = true;
  let queries: readonly AliasableExpression<Row>[];
  try {
    queries = build();
    if (!Array.isArray(queries))
      throw new Error('Company proof batches require synchronous queries');
  } finally {
    companyProofBatch = false;
  }
  const ids = [...new Set(sessionIds)];
  // Pulling the canonical proof into the origin joins multiplied measured PostgreSQL planning work.
  const source = sql<CompanyProofBatchRow>`(select
    batch_company_origin.session_id, batch_company_origin.workspace_id,
    batch_company_origin.connection_id, batch_company_session.user_id
    from workspace_identity_sessions as batch_company_origin
    join sessions as batch_company_session on batch_company_session.id = batch_company_origin.session_id
    join workspace_members as batch_company_member
      on batch_company_member.workspace_id = batch_company_origin.workspace_id
      and batch_company_member.user_id = batch_company_session.user_id
    join users as batch_company_person on batch_company_person.id = batch_company_session.user_id
    join workspaces as batch_company_workspace on batch_company_workspace.id = batch_company_origin.workspace_id
    where batch_company_session.id in (${ids.length === 0 ? sql`null` : sql.join(ids)})
    and (${canonicalLiveCompanySessionProof(
      sql.ref<string>('batch_company_session.id'),
      sql.ref<string>('batch_company_origin.workspace_id'),
      sql.ref<string>('batch_company_session.user_id'),
      sql.ref<string>('batch_company_origin.connection_id'),
      {
        member: 'batch_company_member',
        person: 'batch_company_person',
        workspace: 'batch_company_workspace',
      },
    )}) is true)`;
  return { name: COMPANY_PROOF_BATCH_NAME, source, queries };
};
