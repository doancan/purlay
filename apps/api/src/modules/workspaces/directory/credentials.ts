/** A bearer has one purpose, an immutable random digest and a terminal bounded lifetime. */
import type { Executor, Database, Selectable } from '@purlay/db';
import type { Clock } from '../../../platform/clock';
import { digestsEqual, randomToken, tokenDigest } from '../../../platform/tokens';

export const newDirectoryToken = (id: string): string => `purlay_scim_${id}.${randomToken()}`;
export interface VerifiedDirectoryCredential {
  readonly credentialId: string;
  readonly directory: Selectable<Database['workspace_directories']>;
  readonly expiresAt: Date;
}
/** Authentication is repeated under the workspace lock before the first native subject write. */
export const verifyDirectoryToken = async (
  database: Executor,
  clock: Clock,
  token: string,
): Promise<VerifiedDirectoryCredential | null> => {
  const match =
    /^purlay_scim_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/.exec(
      token,
    );
  const id = match?.[1];
  if (id === undefined) return null;
  const credential = await database
    .selectFrom('workspace_directory_credentials')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (
    credential?.revoked_at !== null ||
    new Date(credential.expires_at).getTime() <= clock.now().getTime() ||
    !digestsEqual(await tokenDigest(token), credential.token_hash)
  )
    return null;
  const directory = await database
    .selectFrom('workspace_directories')
    .selectAll()
    .where('id', '=', credential.directory_id)
    .where('workspace_id', '=', credential.workspace_id)
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (directory === undefined) return null;
  return { credentialId: credential.id, directory, expiresAt: new Date(credential.expires_at) };
};
