import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql } from '@purlay/db';
import { messageId } from '@purlay/types';
import { aRoom } from '../testing/rooms';
import { DAY_MS } from '../platform/clock';
import { anOutboxRow, aWorkspaceRow } from '../testing/facts';

/** Runs `bun run job <name>` as a scheduler does, with the test database and this `MODULES`. */
const job = async (
  name: string,
  modules: string | undefined,
  databaseUrl = process.env['DATABASE_URL'] ?? '',
  extraEnvironment: Readonly<Record<string, string>> = {},
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
      ...extraEnvironment,
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
    for (const name of [
      'purge:retention',
      'sweep:link-previews',
      'sweep:github-deliveries',
      'sweep:guest-expiry',
    ]) {
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

describe('integration: sweep:outbox as the scheduler runs it (D-288 §12)', () => {
  test('keeps a dead fact for OUTBOX_DEAD_KEPT_DAYS, 180 unless set, and says what it took', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      const workspaceId = await aWorkspaceRow(cloned.db);
      const ago = (days: number): Date => new Date(Date.now() - days * DAY_MS);
      await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(100) });
      await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(20) });
      await anOutboxRow(cloned.db, workspaceId, { state: 'discarded', at: ago(100) });
      const left = async (): Promise<number> =>
        (
          await cloned.db
            .selectFrom('outbox')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .execute()
        ).length;

      const byDefault = await job('sweep:outbox', undefined, cloned.connectionString);
      expect(byDefault.code).toBe(0);
      expect(byDefault.said).toContain('"dead":0,"discarded":0');
      expect(await left()).toBe(3);

      const shorter = await job('sweep:outbox', undefined, cloned.connectionString, {
        OUTBOX_DEAD_KEPT_DAYS: '60',
      });
      expect(shorter.said).toContain('"dead":1,"discarded":1');
      expect(await left()).toBe(1);
    } finally {
      await cloned.drop();
    }
  }, 60_000);
});

describe('integration: expired guest cleanup as the scheduler actually runs it', () => {
  test.each(['omitted', 'stopped'] as const)(
    'cleans durable pending rows with chat %s and another process safely repeats it',
    async (mode) => {
      const cloned = await cloneIntegrationDatabase();
      try {
        const room = await aRoom(cloned.db, ['owner', 'guest']);
        const owner = room.members['owner'];
        const guest = room.members['guest'];
        if (owner === undefined || guest === undefined)
          throw new Error('Missing job fixture users');
        await cloned.db
          .updateTable('workspace_members')
          .set({
            access_kind: 'guest',
            guest_modules: ['chat'],
            guest_since: sql<Date>`statement_timestamp() - interval '2 hours'`,
            guest_expires_at: sql<Date>`statement_timestamp() - interval '1 hour'`,
          })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', guest.userId)
          .execute();
        const id = messageId(new Date(Date.now() - 90 * 60_000));
        await cloned.db
          .insertInto('messages')
          .values({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: owner.userId,
            content: 'Private retained job fixture',
            created_at: new Date(Date.now() - 90 * 60_000),
          })
          .execute();
        const scheduledId = messageId(new Date());
        await cloned.db
          .insertInto('scheduled_messages')
          .values({
            id: scheduledId,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            user_id: guest.userId,
            content: 'Pending before expiry',
            send_at: new Date(Date.now() + 86_400_000),
          })
          .execute();
        await cloned.db
          .insertInto('message_reminders')
          .values({
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            user_id: guest.userId,
            message_id: id,
            remind_at: new Date(Date.now() + 86_400_000),
          })
          .execute();
        await cloned.db
          .insertInto('notifications')
          .values({
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            user_id: guest.userId,
            message_id: id,
            type: 'mention',
          })
          .execute();
        await cloned.db
          .updateTable('channel_members')
          .set({ unread_count: 3, unread_mention_count: 1 })
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', guest.userId)
          .execute();
        if (mode === 'stopped')
          await cloned.db
            .insertInto('suspended_modules')
            .values({
              module: 'chat',
              reason: 'paused for test',
              source: 'test',
              suspended_at: new Date(),
            })
            .execute();
        const modules = mode === 'omitted' ? 'none' : undefined;
        const first = await job('sweep:guest-expiry', modules, cloned.connectionString);
        expect(first.code).toBe(0);
        expect(first.said.includes('a scheduled job finished')).toBe(true);
        expect(
          await cloned.db
            .selectFrom('scheduled_messages')
            .select(['state', 'failure_code'])
            .where('id', '=', scheduledId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'failed', failure_code: 'WORKSPACE_NOT_FOUND' });
        expect(
          await cloned.db
            .selectFrom('message_reminders')
            .select('id')
            .where('user_id', '=', guest.userId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await cloned.db
            .selectFrom('notifications')
            .select('id')
            .where('user_id', '=', guest.userId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await cloned.db
            .selectFrom('channel_members')
            .select(['channel_id', 'unread_count'])
            .where('user_id', '=', guest.userId)
            .execute(),
        ).toEqual([{ channel_id: room.channelId, unread_count: 0 }]);
        const again = await job('sweep:guest-expiry', modules, cloned.connectionString);
        expect(again.code).toBe(0);
        const recorded = await cloned.db
          .selectFrom('job_runs')
          .select(['last_success_at', 'consecutive_failures'])
          .where('job_name', '=', 'sweep:guest-expiry')
          .executeTakeFirstOrThrow();
        expect(recorded.last_success_at !== null && recorded.consecutive_failures === 0).toBe(true);
        expect(
          (
            await cloned.db
              .selectFrom('workspace_members')
              .select('access_kind')
              .where('workspace_id', '=', room.workspaceId)
              .where('user_id', '=', guest.userId)
              .executeTakeFirstOrThrow()
          ).access_kind,
        ).toBe('guest');
      } finally {
        await cloned.drop();
      }
    },
    60_000,
  );
});
