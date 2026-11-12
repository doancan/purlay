/** Existing company catalogue state for the central HTTP isolation/role matrices; no authority implementation is replaced. */
import type { Executor } from '@purlay/db';
import { DAY_MS, type Clock } from '../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { credentialCipher } from '../platform/crypto';
import { randomToken, tokenDigest } from '../platform/tokens';
import type { CompanyTxtLookup } from '../modules/workspaces/identity/domains';

export interface CompanyCatalogueIds {
  readonly companyDomainId: string;
  readonly companyDomainRevision: string;
  readonly companyVerifiedDomainId: string;
  readonly companyConnectionId: string;
  readonly companyConnectionRevision: string;
  readonly companyBindingId: string;
}

/** Seed one pending proof, a separate verified domain/provider and the owner's existing private link. */
export const aCompanyCatalogue = async (
  db: Executor,
  clock: Clock,
  workspaceId: string,
  userId: string,
): Promise<CompanyCatalogueIds> => {
  const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
  const pendingId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const proof = `purlay-verification=${randomToken()}`;
  const now = clock.now();
  const pending = await db
    .insertInto('workspace_identity_domains')
    .values({
      id: pendingId,
      workspace_id: workspaceId,
      domain: `pending-${workspaceId}.example.test`,
      challenge_digest: await tokenDigest(proof),
      challenge_encrypted: Buffer.from(await cipher.seal(proof, pendingId)),
      challenge_issued_at: now,
      challenge_expires_at: new Date(now.getTime() + DAY_MS),
    })
    .returning(['id', 'revision'])
    .executeTakeFirstOrThrow();
  const verified = await db
    .insertInto('workspace_identity_domains')
    .values({
      workspace_id: workspaceId,
      domain: `verified-${workspaceId}.example.test`,
      challenge_issued_at: now,
      challenge_expires_at: new Date(now.getTime() + DAY_MS),
      verified_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const authenticationRevision = crypto.randomUUID();
  const connection = await db
    .insertInto('workspace_identity_connections')
    .values({
      id: connectionId,
      workspace_id: workspaceId,
      domain_id: verified.id,
      name: 'Existing office',
      issuer: 'https://identity.example.test',
      client_id: 'matrix-client',
      client_secret_encrypted: Buffer.from(
        await cipher.seal('matrix-company-secret', connectionId),
      ),
      authentication_revision: authenticationRevision,
      tested_authentication_revision: authenticationRevision,
      tested_at: now,
      enabled: true,
    })
    .returning(['id', 'revision'])
    .executeTakeFirstOrThrow();
  const binding = await db
    .insertInto('workspace_identity_bindings')
    .values({
      workspace_id: workspaceId,
      connection_id: connection.id,
      user_id: userId,
      issuer: 'https://identity.example.test',
      subject: `person-${userId}`,
      created_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    companyDomainId: pending.id,
    companyDomainRevision: pending.revision,
    companyVerifiedDomainId: verified.id,
    companyConnectionId: connection.id,
    companyConnectionRevision: connection.revision,
    companyBindingId: binding.id,
  };
};

/** Only external DNS is substituted; return the public TXT proof the fixture actually owns. */
export const companyCatalogueDns =
  (db: Executor): CompanyTxtLookup =>
  async (name) => {
    const prefix = '_purlay-verification.';
    if (!name.startsWith(prefix)) return [];
    const row = await db
      .selectFrom('workspace_identity_domains')
      .select(['id', 'challenge_encrypted'])
      .where('domain', '=', name.slice(prefix.length))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (row?.challenge_encrypted == null) return [];
    return [
      [await credentialCipher(DEVELOPMENT_ENCRYPTION_KEY).open(row.challenge_encrypted, row.id)],
    ];
  };
