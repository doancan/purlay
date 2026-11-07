/** Real creation, URLs, separate clones and cleanup at PostgreSQL's identifier boundary (#1202). */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createDatabase, type DatabasePool } from './client';
import {
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  dropDatabases,
  integrationDatabase,
} from './testing';
import {
  databaseNameFromUrl,
  integrationTemplateName,
  onDatabase,
  scratchDatabaseName,
} from './scratch-databases';

afterAll(closeIntegrationDatabase);

describe('integration: scratch database identifiers', () => {
  for (const multibyte of [false, true]) {
    test(
      `a long ${multibyte ? 'UTF-8' : 'ASCII'} source keeps its data while its templates and clones stay separate`,
      async () => {
        const source = process.env['DATABASE_URL'] ?? '';
        const prefix = `purlay_harness_stale_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_`;
        const unicode = multibyte ? 'ğ'.repeat(10) : '';
        const root = prefix + unicode + 'x'.repeat(63 - prefix.length - Buffer.byteLength(unicode));
        expect(Buffer.byteLength(root)).toBe(63);
        const template = integrationTemplateName(root);
        const explicitTemplate = scratchDatabaseName(`${root}_explicit_template`);
        const control = integrationDatabase();
        let created = false;
        let configured: DatabasePool | undefined;
        try {
          await sql`create database ${sql.id(root)}`.execute(control);
          created = true;
          configured = createDatabase({ connectionString: onDatabase(source, root), poolSize: 1 });
          await sql`create table source_marker (n int)`.execute(configured);
          await sql`insert into source_marker values (42)`.execute(configured);
          const script = `
        import assert from 'node:assert/strict';
        import { buildIntegrationTemplate, cloneIntegrationDatabase, closeIntegrationDatabase, dropDatabases } from ${JSON.stringify(new URL('./testing.ts', import.meta.url).href)};
        import { databaseNameFromUrl, onDatabase } from ${JSON.stringify(new URL('./scratch-databases.ts', import.meta.url).href)};
        import { createDatabase } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
        import { sql } from 'kysely';
        const clones = [];
        let cliName;
        try {
          clones.push(await cloneIntegrationDatabase());
          clones.push(await cloneIntegrationDatabase());
          for (const clone of clones) {
            const name = databaseNameFromUrl(clone.connectionString);
            assert.equal((await sql\`select current_database() as name\`.execute(clone.db)).rows[0]?.name, name);
            assert.equal((await sql\`select to_regclass('source_marker') as t\`.execute(clone.db)).rows[0]?.t, null);
            console.log(name);
          }
          await sql\`create table clone_marker (n int)\`.execute(clones[0].db);
          assert.equal((await sql\`select to_regclass('clone_marker') as t\`.execute(clones[1].db)).rows[0]?.t, null);
          const explicit = await buildIntegrationTemplate(process.env.EXPLICIT_TEMPLATE);
          const check = createDatabase({ connectionString: onDatabase(process.env.DATABASE_URL, explicit), poolSize: 1 });
          try {
            assert.equal((await sql\`select current_database() as name\`.execute(check)).rows[0]?.name, explicit);
          } finally { await check.destroy(); }
          const command = (...args) => Bun.spawnSync([process.execPath, '--no-env-file', ${JSON.stringify(new URL('../../../apps/api/src/cli/throwaway-database.ts', import.meta.url).pathname)}, ...args], { cwd: ${JSON.stringify(new URL('../../../', import.meta.url).pathname)}, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
          const made = command('clone');
          assert.equal(made.exitCode, 0, made.stderr.toString());
          cliName = databaseNameFromUrl(made.stdout.toString().trim());
          const dropped = command('drop', cliName);
          assert.equal(dropped.exitCode, 0, dropped.stderr.toString());
        } finally {
          await Promise.all(clones.map(clone => clone.drop()));
          if (cliName !== undefined) await dropDatabases([cliName]);
          await closeIntegrationDatabase();
        }
      `;
          const child = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', script], {
            cwd: import.meta.dirname,
            env: {
              ...process.env,
              DATABASE_URL: onDatabase(source, root),
              MODULES: 'none',
              EXPLICIT_TEMPLATE: `${root}_explicit_template`,
            },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 45_000,
          });
          expect(child.exitCode === 0 ? 'ok' : child.stderr.toString().slice(-2000)).toBe('ok');
          const names = child.stdout.toString().trim().split('\n');
          expect(new Set(names).size).toBe(2);
          for (const name of names) {
            expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
            expect(name === root || name === template).toBe(false);
          }
          expect(
            (await sql<{ n: number }>`select n from source_marker`.execute(configured)).rows,
          ).toEqual([{ n: 42 }]);
          expect(
            (
              await sql`select datname from pg_database where datname = any(${names}::text[])`.execute(
                control,
              )
            ).rows,
          ).toEqual([]);
          expect(
            (
              await sql`select datname from pg_database where datname = ${template}`.execute(
                control,
              )
            ).rows,
          ).toHaveLength(1);
          expect(databaseNameFromUrl(source)).not.toBe(root);
          expect(
            (
              await sql`select datname from pg_database where datname = ${explicitTemplate}`.execute(
                control,
              )
            ).rows,
          ).toHaveLength(1);
        } finally {
          await configured?.destroy();
          if (created) await dropDatabases([template, explicitTemplate, root]);
        }
        expect(
          (
            await sql`select datname from pg_database where datname = any(${[template, explicitTemplate, root]}::text[])`.execute(
              control,
            )
          ).rows,
        ).toEqual([]);
      },
      DROP_HOOK_MS,
    );
  }
});
