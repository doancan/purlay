/**
 * The router's last resort: a failure it did not anticipate is an `INTERNAL`
 * frame for the client — nothing about the cause — and the cause in the log,
 * under the frame's request (#127).
 */
import { nobodyActive } from '../platform/attention';
import { describe, expect, test } from 'bun:test';
import { DatabaseUnavailableError, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  aTransactionThatMustNotBeTouched,
} from '../testing/doubles';
import { refusalFor } from '../ingress/http/errors';
import { fixedClock } from '../platform/clock';
import { createLogger, withinRequest, type Logger } from '../platform/logging';
import { inProcessEventBus } from './bus';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { inMemoryPresenceRegistry } from './presence';
import { routeFrame } from './router';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const subscribeWith = async (
  database: Executor,
  log: Logger,
  id: string,
): Promise<readonly ServerFrame[]> =>
  await withinRequest(
    { requestId: 'frame-1', startedAt: 0 },
    async () =>
      await routeFrame(
        {
          database,
          clock,
          bus: inProcessEventBus(() => undefined, createLogger({ level: 'silent' })),
          limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          presence: inMemoryPresenceRegistry(clock),
          attention: nobodyActive,
          log,
          socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
          atomically: async (body) => await body(aTransactionThatMustNotBeTouched()),
        },
        { socketId: 's1', userId: 'u1', sessionId: 'not-read', expiresAt: clock.now() },
        {
          id,
          op: 'SUBSCRIBE',
          payload: {
            channels: [{ channelId: '00000000-0000-4000-8000-000000000000', afterMessageId: null }],
          },
        },
      ),
  );

describe('a frame that fails in a way nobody anticipated', () => {
  test('answers INTERNAL with nothing of the cause, and writes the cause down', async () => {
    const { log, lines } = aRecordingLogger();
    const id = messageId(clock.now());
    const replies = await subscribeWith(aDatabaseThatMustNotBeTouched(), log, id);

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

  /**
   * A busy server is not a broken one, and HTTP says so with `DATABASE_UNAVAILABLE`
   * (D-87). The socket answers with the same code and the same words, so a client
   * has one thing to handle and may retry; the cause is still written down.
   */
  /**
   * A write referring to a message the retention purge took that moment (D-139 §2) is the message
   * not found on the socket, as on HTTP — never INTERNAL — and the reference refused is logged by name.
   */
  test('a reference to a message gone from under it is MESSAGE_NOT_FOUND, the code HTTP answers with', async () => {
    const { log, lines } = aRecordingLogger();
    const id = messageId(clock.now());
    const refused = Object.assign(new Error('insert violates foreign key constraint'), {
      code: '23503',
      constraint: 'messages_parent_channel_fkey',
    });
    const replies = await subscribeWith(aDatabaseThatMustNotBeTouched(refused), log, id);
    expect(replies).toEqual([
      {
        event: 'ERROR',
        data: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' },
        ts: clock.now().getTime(),
        refId: id,
      },
    ]);
    expect(replies[0]).toMatchObject({ data: refusalFor('UNKNOWN', refused, []).body.error });
    expect(lines.map((line) => [line['level'], line['msg'], line['constraint']])).toContainEqual([
      'warn',
      'a write referred to a message that is not there',
      'messages_parent_channel_fkey',
    ]);
    expect(lines.some((line) => line['msg'] === 'frame failed')).toBe(false);
  });

  test('a pool with no connection to give is DATABASE_UNAVAILABLE, the code HTTP answers with', async () => {
    const { log, lines } = aRecordingLogger();
    const id = messageId(clock.now());
    const cause = new Error('timeout exceeded when trying to connect');
    const replies = await subscribeWith(
      aDatabaseThatMustNotBeTouched(new DatabaseUnavailableError(cause)),
      log,
      id,
    );

    expect(replies).toEqual([
      {
        event: 'ERROR',
        data: { code: 'DATABASE_UNAVAILABLE', message: 'The service is busy. Try again shortly.' },
        ts: clock.now().getTime(),
        refId: id,
      },
    ]);
    expect(lines.find((line) => line['msg'] === 'frame failed')).toMatchObject({ level: 'error' });
    // And it is the body HTTP answers with, word for word.
    expect(replies[0]).toMatchObject({
      data: refusalFor('UNKNOWN', new DatabaseUnavailableError(cause), []).body.error,
    });
  });
});
