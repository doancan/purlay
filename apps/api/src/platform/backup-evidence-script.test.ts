import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { BackupEvidence, RestoreEvidence } from '@purlay/types';
const folders: string[] = [];
afterAll(async () => {
  await Promise.all(
    folders.map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});
const invoke = async (
  directory: string,
  dump: string,
  restore: boolean,
  scope: string,
): Promise<number> => {
  const process = Bun.spawn(
    [
      'bash',
      '-euc',
      '. "$1"; if [ "$4" = restore ]; then write_restore_evidence "$2" "$3"; else write_backup_evidence "$2" "$3"; fi',
      'evidence-test',
      resolve('scripts/ops-common.sh'),
      dump,
      scope,
      restore ? 'restore' : 'backup',
    ],
    { env: { ...Bun.env, BACKUP_STATUS_DIRECTORY: directory }, stdout: 'pipe', stderr: 'pipe' },
  );
  return await process.exited;
};
describe('operator backup evidence publication', () => {
  test('publishes a bounded receipt with the actual artifact digest, then scoped restore evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'purlay-evidence-script-'));
    folders.push(directory);
    const dump = join(directory, 'fixture.dump');
    const content = 'archive fixture, including punctuation';
    await writeFile(dump, content);
    expect(await invoke(directory, dump, false, 'database')).toBe(0);
    const value: unknown = JSON.parse(await readFile(join(directory, 'backup.json'), 'utf8'));
    expect(Value.Check(BackupEvidence, value)).toBe(true);
    if (!Value.Check(BackupEvidence, value)) throw new Error('invalid evidence');
    expect(value.databaseSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(value.databaseBytes).toBe(String(Buffer.byteLength(content)));
    expect(await invoke(directory, dump, true, 'database')).toBe(0);
    const restored: unknown = JSON.parse(await readFile(join(directory, 'restore.json'), 'utf8'));
    expect(Value.Check(RestoreEvidence, restored)).toBe(true);
    expect(await invoke(directory, dump, false, 'invented')).not.toBe(0);
    expect(await readFile(join(directory, 'backup.json'), 'utf8')).toBe(
      JSON.stringify(value) + '\n',
    );
  });
});
