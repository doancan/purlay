import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBackupEvidence } from './backup-evidence';
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});
const folder = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'purlay-backup-report-'));
  directories.push(path);
  return path;
};
const now = new Date('2026-11-06T10:00:00Z');
const backup = {
  version: 1,
  source: 'backup-script',
  completedAt: now.toISOString(),
  scope: 'database-and-attachments',
  databaseSha256: 'a'.repeat(64),
  databaseBytes: '4096',
  maxAgeSeconds: 3600,
};
describe('backup evidence', () => {
  test('unconfigured and unreported are not a successful backup', async () => {
    expect((await readBackupEvidence(undefined, now)).state).toBe('unconfigured');
    expect((await readBackupEvidence(await folder(), now)).state).toBe('unreported');
  });
  test('reports age and keeps database-only restoration distinct from full recovery', async () => {
    const path = await folder();
    await writeFile(join(path, 'backup.json'), JSON.stringify(backup));
    expect((await readBackupEvidence(path, now)).state).toBe('current');
    expect((await readBackupEvidence(path, new Date(now.getTime() + 3_600_001))).state).toBe(
      'stale',
    );
    await writeFile(
      join(path, 'restore.json'),
      JSON.stringify({
        version: 1,
        source: 'restore-script',
        checkedAt: now.toISOString(),
        scope: 'database',
        databaseSha256: backup.databaseSha256,
      }),
    );
    expect((await readBackupEvidence(path, now)).restoreMatchesLatest).toBe(false);
    await writeFile(
      join(path, 'restore.json'),
      JSON.stringify({
        version: 1,
        source: 'restore-script',
        checkedAt: now.toISOString(),
        scope: 'database-and-attachments',
        databaseSha256: backup.databaseSha256,
      }),
    );
    expect((await readBackupEvidence(path, now)).restoreMatchesLatest).toBe(true);
  });
  test('malformed, oversized, future-dated and secret-bearing reports fail closed without disclosing values', async () => {
    const path = await folder();
    for (const text of [
      '{',
      'x'.repeat(8193),
      JSON.stringify({ ...backup, password: 'do-not-leak' }),
      JSON.stringify({ ...backup, completedAt: '2099-01-01T00:00:00Z' }),
    ]) {
      await writeFile(join(path, 'backup.json'), text);
      const answer = await readBackupEvidence(path, now);
      expect(answer.state).toBe('invalid');
      expect(answer.backup).toBeNull();
      expect(JSON.stringify(answer)).not.toContain('do-not-leak');
    }
  });
});
