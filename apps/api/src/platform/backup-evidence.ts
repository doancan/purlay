/** Operator-produced evidence, mounted read-only. No backup path or archive contents cross the API. */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { BackupEvidence, RestoreEvidence, type ServerBackupStatus } from '@purlay/types';

const readBounded = async (path: string): Promise<unknown> => {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('operational receipt too large');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
};
export const readBackupEvidence = async (
  directory: string | undefined,
  now: Date,
): Promise<ServerBackupStatus> => {
  const empty = {
    checkedAt: now.toISOString(),
    backup: null,
    restore: null,
    restoreMatchesLatest: false,
  };
  if (directory === undefined) return { ...empty, state: 'unconfigured' };
  try {
    const backup: unknown = await readBounded(join(directory, 'backup.json'));
    const restore: unknown = await readBounded(join(directory, 'restore.json'));
    if (backup === null && restore === null) return { ...empty, state: 'unreported' };
    if (
      (backup !== null && !Value.Check(BackupEvidence, backup)) ||
      (restore !== null && !Value.Check(RestoreEvidence, restore))
    )
      return { ...empty, state: 'invalid' };
    const latest = Value.Check(BackupEvidence, backup) ? backup : null;
    const verified = Value.Check(RestoreEvidence, restore) ? restore : null;
    if (
      (latest !== null && Date.parse(latest.completedAt) > now.getTime() + 60_000) ||
      (verified !== null && Date.parse(verified.checkedAt) > now.getTime() + 60_000)
    )
      return { ...empty, state: 'invalid' };
    return {
      ...empty,
      state:
        latest === null
          ? 'unreported'
          : now.getTime() - Date.parse(latest.completedAt) > latest.maxAgeSeconds * 1000
            ? 'stale'
            : 'current',
      backup: latest,
      restore: verified,
      restoreMatchesLatest:
        latest !== null &&
        verified !== null &&
        latest.databaseSha256 === verified.databaseSha256 &&
        (latest.scope === 'database' || verified.scope === 'database-and-attachments'),
    };
  } catch {
    return { ...empty, state: 'invalid' };
  }
};
