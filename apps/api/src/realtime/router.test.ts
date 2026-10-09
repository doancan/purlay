/**
 * The router's last resort: a failure it did not anticipate is an `INTERNAL`
 * frame for the client — nothing about the cause — and the cause in the log,
 * under the frame's request (#127).
 */
import { describe, expect, test } from 'bun:test';
import { messageId } from '@purlay/types';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  aTransactionThatMustNotBeTouched,
} from '../ingress/http/testing';
import { fixedClock } from '../platform/clock';
import { withinRequest } from '../platform/logging';
import { inProcessEventBus } from './bus';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { routeFrame } from './router';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

describe('a frame that fails in a way nobody anticipated', () => {
  test('answers INTERNAL with nothing of the cause, and writes the cause down', async () => {
    const { log, lines } = aRecordingLogger();
    const database = aDatabaseThatMustNotBeTouched();
    const id = messageId(clock.now());
    const replies = await withinRequest(
      { requestId: 'frame-1', startedAt: 0 },
      async () =>
        await routeFrame(
          {
            database,
            clock,
            bus: inProcessEventBus(() => undefined),
            limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
            log,
            atomically: async (body) => await body(aTransactionThatMustNotBeTouched()),
          },
          { socketId: 's1', userId: 'u1', sessionId: 'not-read', expiresAt: clock.now() },
          {
            id,
            op: 'SUBSCRIBE',
            payload: {
              channels: [
                { channelId: '00000000-0000-4000-8000-000000000000', afterMessageId: null },
              ],
            },
          },
        ),
    );

    expect(replies).toEqual([
      {
        event: 'ERROR',
        data: { code: 'INTERNAL', message: 'Something went wrong.' },
        ts: clock.now().getTime(),
        refId: id,
      },
    ]);
    expect(lines.find((line) => line['msg'] === 'frame failed')).toMatchObject({
      level: 'error',
      requestId: 'frame-1',
      op: 'SUBSCRIBE',
      socketId: 's1',
      err: { message: expect.stringContaining('must not touch it') as string },
    });
  });
});
