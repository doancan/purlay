/** Public DNS proof is separate from provider credentials; stale replies consume no newer proof. */
import { Resolver } from 'node:dns/promises';
import type { Database, Selectable } from '@purlay/db';
import {
  COMPANY_DOMAINS_MAX,
  COMPANY_DOMAIN_CHALLENGE_SECONDS,
  normalisedCompanyDomain,
  type CompanyIdentityDomain,
  type CompanyIdentityDomainPage,
} from '@purlay/types/workspace-identity';
import { AppError } from '../../../platform/errors';
import { randomToken, tokenDigest } from '../../../platform/tokens';
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

/** Only the external DNS boundary is replaceable; catalogue and authority always use real SQL. */
export type CompanyTxtLookup = (name: string) => Promise<readonly (readonly string[])[]>;

export const lookupCompanyTxt: CompanyTxtLookup = async (name) => {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  const timeout = setTimeout(() => {
    resolver.cancel();
  }, 5_000);
  try {
    return await resolver.resolveTxt(name);
  } finally {
    clearTimeout(timeout);
  }
};

type DomainRow = Selectable<Database['workspace_identity_domains']>;

const asDomain = async (
  dependencies: CompanyIdentityDependencies,
  row: DomainRow,
): Promise<CompanyIdentityDomain> => {
  const expired =
    new Date(row.challenge_expires_at).getTime() <= dependencies.clock.now().getTime();
  return {
    id: row.id,
    revision: row.revision,
    domain: row.domain,
    state: row.verified_at !== null ? 'verified' : expired ? 'expired' : 'pending',
    dnsRecord:
      row.challenge_encrypted === null || expired
        ? null
        : {
            type: 'TXT',
            name: `_purlay-verification.${row.domain}`,
            value: await dependencies.cipher.open(row.challenge_encrypted, row.id),
          },
    challengeExpiresAt: new Date(row.challenge_expires_at).toISOString(),
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
};

const challenge = async (
  dependencies: CompanyIdentityDependencies,
  id: string,
): Promise<{
  readonly revision: string;
  readonly challenge_digest: string;
  readonly challenge_encrypted: Buffer;
  readonly challenge_issued_at: Date;
  readonly challenge_expires_at: Date;
}> => {
  const proof = `purlay-verification=${randomToken()}`;
  const now = dependencies.clock.now();
  return {
    revision: crypto.randomUUID(),
    challenge_digest: await tokenDigest(proof),
    challenge_encrypted: Buffer.from(await dependencies.cipher.seal(proof, id)),
    challenge_issued_at: now,
    challenge_expires_at: new Date(now.getTime() + COMPANY_DOMAIN_CHALLENGE_SECONDS * 1_000),
  };
};

export const listCompanyDomains = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
): Promise<CompanyIdentityDomainPage> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const rows = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('revoked_at', 'is', null)
      .orderBy('id')
      .limit(COMPANY_DOMAINS_MAX)
      .execute();
    return {
      data: await Promise.all(rows.map(async (row) => await asDomain(dependencies, row))),
      nextCursor: null,
    };
  });

/** Creating an existing canonical domain is idempotent, including when the inventory is full. */
export const createCompanyDomain = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  input: string,
): Promise<CompanyIdentityDomain> => {
  const domain = normalisedCompanyDomain(input);
  if (domain === undefined) throw identityInvalid('domain', 'Enter a company DNS domain.');
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const existing = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('domain', '=', domain)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (existing !== undefined) return await asDomain(dependencies, existing);
    const { count } = await transaction
      .selectFrom('workspace_identity_domains')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', context.workspaceId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count) >= COMPANY_DOMAINS_MAX)
      throw new AppError({
        code: 'COMPANY_IDENTITY_LIMIT',
        message: 'Remove an unused company domain first.',
      });
    const id = crypto.randomUUID();
    const row = await transaction
      .insertInto('workspace_identity_domains')
      .values({
        id,
        workspace_id: context.workspaceId,
        domain,
        ...(await challenge(dependencies, id)),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.domain_created',
      targetType: 'integration',
      targetId: id,
    });
    return await asDomain(dependencies, row);
  });
};

export const renewCompanyDomain = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  revision: string,
): Promise<CompanyIdentityDomain> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const row = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw identityMissing();
    if (row.revision !== revision) throw identityChanged();
    if (row.verified_at !== null) return await asDomain(dependencies, row);
    const renewed = await transaction
      .updateTable('workspace_identity_domains')
      .set({ ...(await challenge(dependencies, id)), updated_at: dependencies.clock.now() })
      .where('id', '=', id)
      .where('workspace_id', '=', context.workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.domain_renewed',
      targetType: 'integration',
      targetId: id,
    });
    return await asDomain(dependencies, renewed);
  });

export const verifyCompanyDomain = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  revision: string,
  lookup: CompanyTxtLookup,
): Promise<CompanyIdentityDomain> => {
  // Both transactions finish before/after the external call. Never hold a row while waiting on DNS.
  const pending = await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const row = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw identityMissing();
    if (row.revision !== revision) throw identityChanged();
    return row;
  });
  if (pending.verified_at !== null) return await asDomain(dependencies, pending);
  if (new Date(pending.challenge_expires_at).getTime() <= dependencies.clock.now().getTime())
    throw identityNotReady('This DNS challenge expired. Create a new challenge.');
  let records: readonly (readonly string[])[];
  try {
    records = await lookup(`_purlay-verification.${pending.domain}`);
  } catch {
    throw identityNotReady(
      'DNS verification could not finish. Check the TXT record and try again.',
    );
  }
  if (records.length > 64 || records.some((record) => record.join('').length > 4_096))
    throw identityNotReady('The DNS answer exceeded the verification limit.');
  const digests = await Promise.all(
    records.map(async (record) => await tokenDigest(record.join(''))),
  );
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const row = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw identityMissing();
    if (row.revision !== revision) throw identityChanged();
    if (row.verified_at !== null) return await asDomain(dependencies, row);
    const now = dependencies.clock.now();
    if (new Date(row.challenge_expires_at).getTime() <= now.getTime())
      throw identityNotReady('This DNS challenge expired. Create a new challenge.');
    if (row.challenge_digest === null || !digests.includes(row.challenge_digest))
      throw identityNotReady('The TXT record does not contain this domain verification value yet.');
    const verified = await transaction
      .updateTable('workspace_identity_domains')
      .set({
        verified_at: now,
        challenge_digest: null,
        challenge_encrypted: null,
        revision: crypto.randomUUID(),
        updated_at: now,
      })
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.domain_verified',
      targetType: 'integration',
      targetId: id,
    });
    return await asDomain(dependencies, verified);
  });
};

export const revokeCompanyDomain = async (
  dependencies: CompanyIdentityDependencies,
  actor: CompanyIdentityActor,
  id: string,
  revision: string,
): Promise<void> => {
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const context = await lockCompanyIdentityActor(transaction, dependencies, actor, true);
    const row = await transaction
      .selectFrom('workspace_identity_domains')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) throw identityMissing();
    if (row.revoked_at !== null) return;
    if (row.revision !== revision) throw identityChanged();
    const now = dependencies.clock.now();
    await transaction
      .updateTable('workspace_identity_domains')
      .set({
        revoked_at: now,
        challenge_digest: null,
        challenge_encrypted: null,
        revision: crypto.randomUUID(),
        updated_at: now,
      })
      .where('id', '=', id)
      .where('workspace_id', '=', context.workspaceId)
      .execute();
    // Disable and fence in-flight callbacks. Later re-adding the name never restores this authority.
    await transaction
      .updateTable('workspace_identity_connections')
      .set({
        enabled: false,
        revision: crypto.randomUUID(),
        authentication_revision: crypto.randomUUID(),
        tested_authentication_revision: null,
        tested_at: null,
        updated_at: now,
      })
      .where('workspace_id', '=', context.workspaceId)
      .where('domain_id', '=', id)
      .execute();
    await transaction
      .updateTable('workspace_identity_sessions')
      .set({ revoked_at: now })
      .where('workspace_id', '=', context.workspaceId)
      .where(
        'connection_id',
        'in',
        transaction
          .selectFrom('workspace_identity_connections')
          .select('id')
          .where('workspace_id', '=', context.workspaceId)
          .where('domain_id', '=', id),
      )
      .where('revoked_at', 'is', null)
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'identity.domain_revoked',
      targetType: 'integration',
      targetId: id,
    });
  });
};
