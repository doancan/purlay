/**
 * A connection that sends faster than its frames can be handled is cut off.
 *
 * Whether a queue fills depends on how fast frames are handled, so the handling is
 * made slow on purpose — the database holds every read for a moment — instead of
 * hoping the machine is slow enough. (A flood of pings did not fill it on CI.)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser } from '../testing/signed-in';
import { aRecordingLogger, testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { FRAME_QUEUE_MAX } from './hub';

const origin = 'https://purlay.test';
const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));
let cloned: ClonedDatabase;
let app: HttpApplication;
let server = '';
let slow = false;
const recorded = aRecordingLogger();

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const database = cloned.db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      if (slow) await Bun.sleep(100);
      return args.result;
    },
  });
  app = createApp(
    testDependencies({
      database,
      clock,
      config: testConfig({ APP_URL: origin }),
      log: recorded.log,
    }),
  );
  server = `http://localhost:${String(app.listen(0))}`;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

describe('integration: a connection that outpaces its frames', () => {
  test('is cut off once the queue behind the frame being handled is full, and the server says why', async () => {
    const user = await aSignedInUser(cloned.db, clock, 'flood');
    const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
      headers: { cookie: user.cookie, origin },
    } as unknown as string[]);
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        resolve();
      });
    });

    slow = true;
    // Each subscription waits on the database, so none is finished before the
    // next arrives; more than the queue holds.
    for (let i = 0; i <= FRAME_QUEUE_MAX + 5; i += 1) {
      socket.send(
        JSON.stringify({
          id: messageId(new Date(clock.now().getTime() + i)),
          op: 'SUBSCRIBE',
          payload: {
            channels: [{ channelId: '00000000-0000-4000-8000-000000000001', afterMessageId: null }],
          },
        }),
      );
    }

    const deadline = Date.now() + 5_000;
    const said = (): boolean =>
      recorded.lines.some(
        (line) =>
          line['msg'] === 'socket sent frames faster than they could be handled and was closed',
      );
    while (!said() && Date.now() < deadline) await Bun.sleep(10);
    slow = false;
    expect(said()).toBe(true);
  });
});
