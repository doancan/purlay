/** A signed company claim may select only the exact consenting or directory-created canonical link. */
import { acquireActiveSCIMUserLink } from '@better-auth/scim';
import type { DBTransactionAdapter } from '@better-auth/core/db/adapter';
import type { Transaction } from '@purlay/db';
import { Uuid } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import type { OidcProfile } from '../../auth/oidc';
import { identityChanged, identityNotReady } from '../identity/authority';
import type { CompanyConnectionSnapshot } from '../identity/catalogue';

const directoryExternalIdentity = (
  snapshot: CompanyConnectionSnapshot,
  profile: OidcProfile,
): string | null => {
  if (snapshot.directoryId === null) return null;
  const value =
    snapshot.directoryClaim === 'sub'
      ? profile.sub
      : snapshot.directoryClaim === 'oid'
        ? profile.oid
        : undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    (snapshot.directoryClaim === 'oid' && !Value.Check(Uuid, value))
  )
    throw identityNotReady('The provider did not supply the configured verified directory claim.');
  return value;
};
export const consentDirectoryIdentity = async (
  tx: Transaction,
  snapshot: CompanyConnectionSnapshot,
  profile: OidcProfile,
  userId: string,
  bindingId: string,
  at: Date,
): Promise<void> => {
  const externalId = directoryExternalIdentity(snapshot, profile);
  if (snapshot.directoryId === null || externalId === null) return;
  const directory = await tx
    .selectFrom('workspace_directories')
    .select('id')
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('id', '=', snapshot.directoryId)
    .where('connection_id', '=', snapshot.id)
    .where('claim', '=', snapshot.directoryClaim ?? '')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (directory === undefined) throw identityChanged();
  const links = await tx
    .selectFrom('workspace_directory_identity_links')
    .selectAll()
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('directory_id', '=', snapshot.directoryId)
    .where((eb) => eb.or([eb('external_id', '=', externalId), eb('user_id', '=', userId)]))
    .execute();
  if (links.some((link) => link.user_id !== userId || link.external_id !== externalId))
    throw identityChanged();
  let link = links[0];
  link ??= await tx
    .insertInto('workspace_directory_identity_links')
    .values({
      workspace_id: snapshot.workspaceId,
      directory_id: snapshot.directoryId,
      user_id: userId,
      external_id: externalId,
      origin: 'company_link',
      binding_reference: bindingId,
      created_at: at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('workspace_directory_native_initializations')
    .values({ link_reference: link.id, binding_reference: bindingId, created_at: at })
    .onConflict((conflict) => conflict.column('link_reference').doNothing())
    .execute();
};
export interface DirectorySignInProof {
  readonly directory_id: string;
  readonly directory_link_reference: string;
  readonly directory_authorization_revision: string;
  readonly source_id: string;
  readonly source_authorization_revision: string;
  readonly admission_revision: string;
}
export const activeDirectoryIdentity = async (
  tx: Transaction,
  adapter: DBTransactionAdapter,
  snapshot: CompanyConnectionSnapshot,
  profile: OidcProfile,
  expectedUserId?: string,
): Promise<{ readonly userId: string; readonly proof: DirectorySignInProof } | null> => {
  const externalId = directoryExternalIdentity(snapshot, profile);
  if (snapshot.directoryId === null || externalId === null) return null;
  const directory = await tx
    .selectFrom('workspace_directories')
    .selectAll()
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('id', '=', snapshot.directoryId)
    .where('connection_id', '=', snapshot.id)
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (directory === undefined) throw identityChanged();
  const link = await acquireActiveSCIMUserLink(
    { connectionId: snapshot.directoryId, externalId },
    { database: adapter },
  );
  if (link === null || (expectedUserId !== undefined && link.userId !== expectedUserId))
    throw identityNotReady('An active exact directory identity is required.');
  const consent = await tx
    .selectFrom('workspace_directory_identity_links')
    .select('user_id')
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('directory_id', '=', snapshot.directoryId)
    .where('external_id', '=', externalId)
    .where('user_id', '=', link.userId)
    .executeTakeFirst();
  const source = await tx
    .selectFrom('workspace_access_sources')
    .select(['id', 'authorization_revision'])
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('directory_id', '=', snapshot.directoryId)
    .where('directory_link_reference', '=', link.scimUserId)
    .where('kind', '=', 'directory')
    .where('state', '=', 'active')
    .where('user_id', '=', link.userId)
    .executeTakeFirst();
  const control = await tx
    .selectFrom('workspace_admission_controls')
    .select('revision')
    .where('workspace_id', '=', snapshot.workspaceId)
    .where('user_id', '=', link.userId)
    .where('blocked_at', 'is', null)
    .executeTakeFirst();
  if (consent === undefined || source === undefined || control === undefined)
    throw identityNotReady('This directory source cannot admit the person.');
  return {
    userId: link.userId,
    proof: {
      directory_id: snapshot.directoryId,
      directory_link_reference: link.scimUserId,
      directory_authorization_revision: directory.authorization_revision,
      source_id: source.id,
      source_authorization_revision: source.authorization_revision,
      admission_revision: control.revision,
    },
  };
};
