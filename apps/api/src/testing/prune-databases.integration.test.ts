/** A configured source remains excluded when its valid connection URL percent-encodes ASCII (#1202). */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  dropDatabases,
  integrationDatabase,
  onDatabase,
  sql,
} from '@purlay/db';

afterAll(closeIntegrationDatabase);

describe('integration: configured scratch database pruning', () => {
  test(
    'the prune command compares the actual configured name and still lists a separate unused scratch database',
    async () => {
      const source = process.env['DATABASE_URL'] ?? '';
      const prefix = `purlay_harness_stale_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const configured = `${prefix}_configured`;
      const candidate = `${prefix}_candidate`;
      const control = integrationDatabase();
      const owned: string[] = [];
      try {
        for (const name of [configured, candidate]) {
          await sql`create database ${sql.id(name)}`.execute(control);
          owned.push(name);
        }
        const encoded = new URL(onDatabase(source, configured));
        encoded.pathname = `/%70${configured.slice(1)}`;
        const child = Bun.spawnSync(
          [
            process.execPath,
            '--no-env-file',
            new URL('../../../../scripts/prune-databases.ts', import.meta.url).pathname,
          ],
          {
            cwd: new URL('../../../../', import.meta.url).pathname,
            env: { ...process.env, DATABASE_URL: encoded.toString() },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
          },
        );
        expect(child.exitCode === 0 ? 'ok' : child.stderr.toString().slice(-2000)).toBe('ok');
        const lines = child.stdout.toString().split('\n');
        expect(lines.includes(candidate)).toBe(true);
        expect(lines.includes(configured)).toBe(false);
        // This is the real command's default dry run: none of the server's other databases may be dropped.
        expect(
          (
            await sql`select datname from pg_database where datname = any(${owned}::text[])`.execute(
              control,
            )
          ).rows,
        ).toHaveLength(2);
      } finally {
        await dropDatabases(owned);
      }
    },
    DROP_HOOK_MS,
  );
});
