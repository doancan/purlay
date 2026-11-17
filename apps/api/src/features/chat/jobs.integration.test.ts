/**
 * The work chat supplies for the scheduled jobs its manifest names (`jobs.ts`, D-260): each entry is the function the
 * job command runs, given what the command gives it, and does what the job is for.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { noEntitledWorkspaces } from '../../platform/entitled-workspaces';
import type { JobContext } from '../../modules/jobs/jobs';
import type { SendMail } from '../../platform/mail';
import { credentialCipher } from '../../platform/crypto';
import { aRecordingLogger, testConfig } from '../../testing/doubles';
import { aMemoryStore } from '../../testing/storage';
import { chatModule } from './module';
import { chatJobWork } from './jobs';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('integration: the work chat supplies for its jobs', () => {
  const contextOn = (
    database: JobContext['database'],
    relays: (SendMail | undefined)[] = [],
  ): JobContext => ({
    database,
    clock: fixedClock(NOW),
    log: aRecordingLogger().log,
    storage: aMemoryStore(),
    appUrl: 'http://localhost:3000',
    entitled: noEntitledWorkspaces,
    withMailer: async (use): ReturnType<typeof use> => {
      relays.push(undefined);
      return await use(undefined);
    },
  });

  test('is exactly the jobs and the retention its manifest names', () => {
    const named = [...chatModule.manifest.jobs, ...chatModule.manifest.retention];
    expect(Object.keys(chatJobWork).sort()).toEqual(named.sort());
  });

  test('the sweeps and the purge run on an empty database and say what they did', async () => {
    await withRollback(async (db) => {
      const context = contextOn(db);
      expect(await chatJobWork['sweep:guest-expiry']?.(context)).toEqual({
        guests: 0,
        scheduled: 0,
        reservations: 0,
        reminders: 0,
        notifications: 0,
        channels: 0,
        deferred: 0,
      });
      expect(await chatJobWork['sweep:link-previews']?.(context)).toEqual({ removed: 0 });
      expect(await chatJobWork['sweep:github-deliveries']?.(context)).toMatchObject({
        removed: expect.any(Number) as number,
      });
      expect(await chatJobWork['purge:retention']?.(context)).toMatchObject({
        workspaces: 0,
        leftBehind: 0,
      });
    });
  });

  test('the missed mail asks for the relay once, and with none set mails nothing', async () => {
    await withRollback(async (db) => {
      const relays: (SendMail | undefined)[] = [];
      const outcome = await chatJobWork['mail:missed']?.(contextOn(db, relays));
      expect(relays).toHaveLength(1);
      expect(outcome).toEqual({ letters: 0, failed: 0, refused: 0, forgotten: 0 });
    });
  });
});

describe('integration: webhook regression coverage', () => {
  test('webhook jobs dispatch and sweep an empty queue, and require the configured cipher', async () => {
    await withRollback(async (db) => {
      const context: JobContext = {
        database: db,
        clock: fixedClock(NOW),
        log: aRecordingLogger().log,
        storage: aMemoryStore(),
        appUrl: 'https://purlay.test',
        entitled: noEntitledWorkspaces,
        withMailer: async (use) => await use(undefined),
      };
      const delivery = chatJobWork['deliver:webhooks'];
      const sweep = chatJobWork['sweep:webhook-deliveries'];
      if (delivery === undefined || sweep === undefined) throw new Error('missing webhook jobs');
      const message = await delivery(context).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(message).toContain('credential cipher');
      expect(
        await delivery({ ...context, cipher: credentialCipher(testConfig().ENCRYPTION_KEY) }),
      ).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
      expect(await sweep(context)).toEqual({ removed: 0 });
    });
  });
});
