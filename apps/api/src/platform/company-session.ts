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
  capturedDirectoryId?: string | null,
): RawBuilder<boolean> => sql<boolean>`(
  ${sql.ref(`${alias}.company_workspace_id`)} is null or (
    ${sql.ref(`${alias}.company_workspace_id`)} = ${workspaceId}
    and ${capturedDirectoryId === null ? sql<boolean>`${sql.ref(`${alias}.directory_id`)} is null` : sql<boolean>`true`}
    and ${liveCompanySessionProof(sql.ref<string>(`${alias}.id`), workspaceId, sql.ref<string>(`${alias}.user_id`), undefined, companions, capturedDirectoryId === null ? sql<string | null>`null` : sql.ref<string | null>(`${alias}.directory_id`), capturedDirectoryId)}
  )
)`;

/** A retained origin is authority only while its exact provider, binding and native membership remain live. */
const canonicalLiveCompanySessionProof = (
  sessionId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  userId: string | RawBuilder<string>,
  connectionId?: string | RawBuilder<string>,
  companions?: CompanyProofCompanions,
  directoryId?: RawBuilder<string | null>,
  capturedDirectoryId?: string | null,
  reuseOuterProof = false,
): RawBuilder<boolean> => {
  const member = companions?.member ?? 'company_member';
  const person = companions?.person ?? 'company_person';
  const workspace = companions?.workspace ?? 'company_workspace';
  const connectionKey = sql<boolean>`company_connection.workspace_id = company_proof.workspace_id
    and company_connection.id = company_proof.connection_id`;
  const manualSource = sql<boolean>`(company_connection.directory_id is null and company_proof.directory_id is null
    and not exists (
      select 1 from workspace_admission_controls as manual_control
      where manual_control.workspace_id = company_proof.workspace_id
        and manual_control.user_id = company_binding.user_id
        and (manual_control.blocked_at is not null or not exists (
          select 1 from workspace_access_sources as manual_source
          where manual_source.workspace_id = manual_control.workspace_id
            and manual_source.user_id = manual_control.user_id
            and manual_source.kind = 'manual' and manual_source.state = 'active'
        ))
    ))`;
  // A captured native NULL cannot gain directory authority; retain its exact live origin check above.
  const source =
    capturedDirectoryId === null
      ? manualSource
      : sql<boolean>`(
      ${manualSource}
      or (company_connection.directory_id = company_proof.directory_id and exists (
        select 1 from workspace_directories as issuing_directory
        join workspace_access_sources as issuing_source
          on issuing_source.workspace_id = issuing_directory.workspace_id
          and issuing_source.directory_id = issuing_directory.id
          and issuing_source.id = company_proof.source_id
          and issuing_source.directory_link_reference = company_proof.directory_link_reference
          and issuing_source.authorization_revision = company_proof.source_authorization_revision
          and issuing_source.kind = 'directory' and issuing_source.state = 'active'
          and issuing_source.user_id = company_binding.user_id
        join workspace_admission_controls as issuing_control
          on issuing_control.workspace_id = issuing_source.workspace_id
          and issuing_control.user_id = issuing_source.user_id and issuing_control.blocked_at is null
        join workspace_directory_scim_users as issuing_resource
          on issuing_resource.id = company_proof.directory_link_reference
          and issuing_resource.connection_id = issuing_directory.id::text
          and issuing_resource.provisioning_domain_id = issuing_directory.workspace_id::text
          and issuing_resource.user_id = company_binding.user_id and issuing_resource.active
        join workspace_directory_identity_links as issuing_link
          on issuing_link.directory_id = issuing_directory.id
          and issuing_link.workspace_id = issuing_directory.workspace_id
          and issuing_link.user_id = company_binding.user_id
          and issuing_link.external_id = issuing_resource.external_id
        where issuing_directory.workspace_id = company_proof.workspace_id
          and issuing_directory.id = company_proof.directory_id
          and issuing_directory.connection_id = company_connection.id
          and issuing_directory.claim = company_connection.directory_claim
          and issuing_directory.authorization_revision = company_proof.directory_authorization_revision
          and issuing_directory.enabled and issuing_directory.deleted_at is null
      ))
    )`;
  return sql<boolean>`exists (
  select 1
  from ${
    reuseOuterProof
      ? sql`workspace_identity_connections as company_connection`
      : sql`workspace_identity_sessions as company_proof
  join workspace_identity_connections as company_connection
    on ${connectionKey}`
  }
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
  where ${reuseOuterProof ? sql`${connectionKey} and` : sql``} company_proof.session_id = ${sessionId}
    and company_proof.workspace_id = ${workspaceId}
    and ${connectionId === undefined ? sql<boolean>`true` : sql<boolean>`company_proof.connection_id = ${connectionId}`}
    and company_binding.user_id = ${userId}
    and ${sql.ref(`${member}.workspace_id`)} = company_proof.workspace_id
    and ${sql.ref(`${member}.user_id`)} = company_binding.user_id
    and ${sql.ref(`${person}.id`)} = company_binding.user_id
    and ${sql.ref(`${workspace}.id`)} = company_proof.workspace_id
    and company_proof.directory_id is not distinct from ${directoryId ?? sql<string | null>`(select origin.directory_id from sessions as origin where origin.id = ${sessionId} and origin.user_id = ${userId})`}
    and ${source}
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
  readonly directory_id: string | null;
}
interface CompanyProofBatchContext {
  calls: number;
  onlyCapturedManual: boolean;
  readonly workspaceIds: Set<string>;
  unknownWorkspace: boolean;
}
let companyProofBatch: CompanyProofBatchContext | undefined;

/** Outside synchronous final-batch construction, every caller retains the full canonical SQL proof. */
export const liveCompanySessionProof = (
  sessionId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  userId: string | RawBuilder<string>,
  connectionId?: string | RawBuilder<string>,
  companions?: CompanyProofCompanions,
  directoryId?: RawBuilder<string | null>,
  capturedDirectoryId?: string | null,
): RawBuilder<boolean> => {
  const batch = companyProofBatch;
  if (batch === undefined)
    return canonicalLiveCompanySessionProof(
      sessionId,
      workspaceId,
      userId,
      connectionId,
      companions,
      directoryId,
      capturedDirectoryId,
    );
  if (typeof workspaceId === 'string') batch.workspaceIds.add(workspaceId);
  else batch.unknownWorkspace = true;
  batch.calls++;
  batch.onlyCapturedManual &&= capturedDirectoryId === null;
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
      and ready_company_proof.directory_id is not distinct from ${directoryId ?? sql<string | null>`(select origin.directory_id from sessions as origin where origin.id = ${sessionId} and origin.user_id = ${userId})`}
      and ${capturedDirectoryId === null ? sql<boolean>`ready_company_proof.directory_id is null` : sql<boolean>`true`}
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
  if (companyProofBatch !== undefined) throw new Error('Company proof batches cannot be nested');
  const context: CompanyProofBatchContext = {
    calls: 0,
    onlyCapturedManual: true,
    workspaceIds: new Set(),
    unknownWorkspace: false,
  };
  companyProofBatch = context;
  let queries: readonly AliasableExpression<Row>[];
  try {
    queries = build();
    if (!Array.isArray(queries))
      throw new Error('Company proof batches require synchronous queries');
  } finally {
    companyProofBatch = undefined;
  }
  const ids = [...new Set(sessionIds)];
  const workspaceIds = [...context.workspaceIds];
  const firstWorkspaceId = workspaceIds[0];
  const workspaceScope =
    context.unknownWorkspace || firstWorkspaceId === undefined
      ? sql<boolean>`true`
      : workspaceIds.length === 1
        ? sql<boolean>`company_proof.workspace_id = ${firstWorkspaceId}`
        : sql<boolean>`company_proof.workspace_id in (${sql.join(workspaceIds)})`;
  const manual = context.calls > 0 && context.onlyCapturedManual;
  // Pulling the canonical proof into the origin joins multiplied measured PostgreSQL planning work.
  const source = sql<CompanyProofBatchRow>`(select
    company_proof.session_id, company_proof.workspace_id,
    company_proof.connection_id, batch_company_session.user_id, company_proof.directory_id
    from workspace_identity_sessions as company_proof
    join sessions as batch_company_session on batch_company_session.id = company_proof.session_id
    join workspace_members as batch_company_member
      on batch_company_member.workspace_id = company_proof.workspace_id
      and batch_company_member.user_id = batch_company_session.user_id
    join users as batch_company_person on batch_company_person.id = batch_company_session.user_id
    join workspaces as batch_company_workspace on batch_company_workspace.id = company_proof.workspace_id
    where batch_company_session.id in (${ids.length === 0 ? sql`null` : sql.join(ids)})
    and ${workspaceScope}
    and ${manual ? sql<boolean>`batch_company_session.directory_id is null` : sql<boolean>`true`}
    and (${canonicalLiveCompanySessionProof(
      sql.ref<string>('batch_company_session.id'),
      sql.ref<string>('company_proof.workspace_id'),
      sql.ref<string>('batch_company_session.user_id'),
      sql.ref<string>('company_proof.connection_id'),
      {
        member: 'batch_company_member',
        person: 'batch_company_person',
        workspace: 'batch_company_workspace',
      },
      manual
        ? sql<string | null>`null`
        : sql.ref<string | null>('batch_company_session.directory_id'),
      manual ? null : undefined,
      true,
    )}) is true)`;
  return { name: COMPANY_PROOF_BATCH_NAME, source, queries };
};
