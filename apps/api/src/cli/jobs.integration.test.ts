import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cloneIntegrationDatabase, closeIntegrationDatabase } from '@purlay/db';

/** Runs `bun run job <name>` as a scheduler does, with the test database and this `MODULES`. */
const job = async (
  name: string,
  modules: string | undefined,
  databaseUrl = process.env['DATABASE_URL'] ?? '',
): Promise<{ code: number; said: string }> => {
  const process_ = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, 'jobs.ts'), name], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: databaseUrl,
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      ...(modules === undefined ? {} : { MODULES: modules }),
    },
  });
  const code = await process_.exited;
  const said = `${await new Response(process_.stdout).text()}${await new Response(process_.stderr).text()}`;
  return { code, said };
};

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: the scheduled jobs of a module the administrator has stopped (D-296)', () => {
  test('are not run, say why, and are not overdue; its retention goes on, and a resume brings the job back', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      await cloned.db
        .insertInto('suspended_modules')
        .values({ module: 'chat', reason: 'misbehaving', source: 'test', suspended_at: new Date() })
        .execute();
      const left = await job('mail:missed', undefined, cloned.connectionString);
      expect(left.code).toBe(0);
      expect(left.said).toContain('the job belongs to a module that is not run');
      expect(left.said).toContain('"stopped":true');
      const retained = await job('purge:retention', undefined, cloned.connectionString);
      expect(retained.said).toContain('a scheduled job finished');
      const status = await job('jobs:status', undefined, cloned.connectionString);
      expect(status.said).not.toContain('mail:missed');
      expect(status.said).toContain('purge:retention');

      await cloned.db.deleteFrom('suspended_modules').execute();
      const back = await job('mail:missed', undefined, cloned.connectionString);
      expect(back.said).toContain('a scheduled job finished');
    } finally {
      await cloned.drop();
    }
  }, 60_000);
});

describe('integration: the scheduled jobs of the modules a process runs', () => {
  test('a job of a module that is not run exits 0 and says there was nothing to do', async () => {
    for (const name of ['mail:missed']) {
      const { code, said } = await job(name, 'none');
      expect(code).toBe(0);
      expect(said).toContain('the job belongs to a module that is not run');
    }
  }, 30_000);

  test('a job that finished and a job left alone are each logged with the module they are for', async () => {
    const lineSaying = (said: string, msg: string): Record<string, unknown> | undefined =>
      said
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => String(line['msg']).startsWith(msg));
    const ran = await job('sweep:sessions', 'none');
    expect(lineSaying(ran.said, 'a scheduled job finished')).toMatchObject({
      job: 'sweep:sessions',
      module: 'core',
    });
    const left = await job('mail:missed', 'none');
    expect(lineSaying(left.said, 'the job belongs to a module that is not run')).toMatchObject({
      job: 'mail:missed',
      module: 'chat',
    });
  }, 30_000);

  test('the status report leaves the closed jobs out, so none of them is overdue', async () => {
    const { said } = await job('jobs:status', 'none');
    expect(said).toContain('sweep:sessions');
    // What acts for chat's users is not overdue with chat off; keeping its rows within retention still is.
    expect(said).toContain('purge:retention');
    expect(said).not.toContain('mail:missed');
  }, 30_000);

  test('the purge and the sweeps of chat’s rows run with chat off, as the core’s own do', async () => {
    for (const name of ['purge:retention', 'sweep:link-previews', 'sweep:github-deliveries']) {
      const { code, said } = await job(name, 'none');
      expect(code).toBe(0);
      expect(said).toContain('a scheduled job finished');
    }
  }, 30_000);

  test('the missed mail runs where chat does, and an unknown job lists the core’s and the modules’', async () => {
    const mail = await job('mail:missed', 'chat');
    expect(mail.code).toBe(0);
    expect(mail.said).toContain('a scheduled job finished');
    const unknown = await job('no:such', 'issues');
    expect(unknown.code).toBe(2);
    expect(unknown.said).toContain('purge:retention');
    expect(unknown.said).not.toContain('mail:missed');
  }, 30_000);

  test('with every module run, the same jobs are in the report', async () => {
    const { said } = await job('jobs:status', undefined);
    expect(said).toContain('purge:retention');
    expect(said).toContain('mail:missed');
  }, 30_000);

  test('a setting that names a module the build does not carry stops the job', async () => {
    const { code, said } = await job('sweep:sessions', 'calendar');
    expect(code).not.toBe(0);
    expect(said).toContain('calendar');
  }, 30_000);
});
