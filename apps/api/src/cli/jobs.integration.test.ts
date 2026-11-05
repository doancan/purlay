import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/** Runs `bun run job <name>` as a scheduler does, with the test database and this `MODULES`. */
const job = async (
  name: string,
  modules: string | undefined,
): Promise<{ code: number; said: string }> => {
  const process_ = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, 'jobs.ts'), name], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: process.env['DATABASE_URL'] ?? '',
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      ...(modules === undefined ? {} : { MODULES: modules }),
    },
  });
  const code = await process_.exited;
  const said = `${await new Response(process_.stdout).text()}${await new Response(process_.stderr).text()}`;
  return { code, said };
};

describe('integration: the scheduled jobs of the modules a process runs', () => {
  test('a job of a module that is not run exits 0 and says there was nothing to do', async () => {
    for (const name of ['mail:missed']) {
      const { code, said } = await job(name, 'none');
      expect(code).toBe(0);
      expect(said).toContain('the job belongs to a module that is not run');
    }
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
