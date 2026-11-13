/**
 * The socket door's open, when the identity cannot be read.
 *
 * Admission checked the session before the socket was bound; the read that
 * resolves the identity on open can still fail (the database went away between
 * the two). Left to throw, the framework answered with a raw `{"error":…}` body
 * that is not a frame — which the client takes for a malformed one and reconnects
 * into at once.
 */
import { nobodyActive } from '../../platform/attention';
import { describe, expect, test } from 'bun:test';
import { DatabaseUnavailableError } from '@purlay/db';
import { CLOSE_CODES, ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { SESSION_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';
import {
  aDatabaseThatMustNotBeTouched,
  anAuthThatMustNotBeTouched,
  aRecordingLogger,
  testConfig,
} from '../../testing/doubles';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from '../../realtime/rate-limiter';
import { offlinePresence } from '../../realtime/online';
import { createSocketLifecycle, type SocketDependencies } from './socket';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const opening = async (
  failure: Error,
): Promise<{ sent: unknown[]; closed: { code: number; reason: string }[]; logged: unknown[] }> => {
  const { log, lines } = aRecordingLogger();
  const lifecycle = createSocketLifecycle({
    config: testConfig(),
    // The read that fails is the session's: the seam is where the database is first reached.
    auth: anAuthThatMustNotBeTouched(failure),
    database: aDatabaseThatMustNotBeTouched(failure),
    clock,
    log,
    userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
    attention: nobodyActive,
  });
  const sent: unknown[] = [];
  const closed: { code: number; reason: string }[] = [];
  await lifecycle.open({
    id: 's1',
    raw: Object.assign(
      {
        send: (payload: string): number => {
          sent.push(JSON.parse(payload));
          return payload.length;
        },
      },
      { getBufferedAmount: (): number => 0 },
    ),
    data: {
      request: new Request('https://purlay.test/ws', {
        headers: { cookie: `${SESSION_COOKIE}=a-token` },
      }),
    },
    close: (code, reason) => {
      closed.push({ code, reason });
    },
  });
  return { sent, closed, logged: lines.filter((line) => line['msg'] === 'socket failed to open') };
};

describe('a socket whose identity cannot be read when it opens', () => {
  test('refuses a transport that cannot report its actual buffered bytes', async () => {
    const { log } = aRecordingLogger();
    const lifecycle = createSocketLifecycle({
      config: testConfig(),
      auth: anAuthThatMustNotBeTouched(),
      database: aDatabaseThatMustNotBeTouched(),
      clock,
      log,
      userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
      attention: nobodyActive,
    });
    const closed: number[] = [];
    const sent: unknown[] = [];
    try {
      await lifecycle.open({
        id: 'unbounded-transport',
        raw: {
          send: (text: string): number => {
            sent.push(JSON.parse(text));
            return text.length;
          },
        },
        data: { request: new Request('https://purlay.test/ws') },
        close: (code): void => {
          closed.push(code);
        },
      });
      expect(sent).toMatchObject([{ event: 'ERROR', data: { code: 'INTERNAL' } }]);
      expect(closed).toEqual([CLOSE_CODES.INTERNAL]);
    } finally {
      lifecycle.closeAll();
    }
  });

  test('is told in a frame from the contract and closed with the code that says why', async () => {
    const { sent, closed, logged } = await opening(new Error('the connection reset'));

    expect(sent).toHaveLength(1);
    // Every frame on the wire is one the contract declares.
    expect(Value.Check(ServerFrame, sent[0])).toBe(true);
    expect(sent[0]).toMatchObject({ event: 'ERROR', data: { code: 'INTERNAL' } });
    expect(closed).toEqual([{ code: CLOSE_CODES.INTERNAL, reason: 'failed-to-open' }]);
    // The cause is written once, for the operator; the client is told nothing of it.
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('connection reset');
  });

  test('a database that is out of connections is a try-again-later, not an internal error', async () => {
    const { sent, closed } = await opening(new DatabaseUnavailableError(new Error('pool')));

    expect(Value.Check(ServerFrame, sent[0])).toBe(true);
    expect(sent[0]).toMatchObject({ event: 'ERROR', data: { code: 'DATABASE_UNAVAILABLE' } });
    expect(closed).toEqual([{ code: CLOSE_CODES.TOO_BUSY, reason: 'failed-to-open' }]);
  });
});

describe('a socket that closes', () => {
  test('says what its frame budget met: frames, the busiest second, refusals (O-4)', () => {
    const { log, lines } = aRecordingLogger();
    const lifecycle = createSocketLifecycle({
      config: testConfig(),
      auth: anAuthThatMustNotBeTouched(),
      database: aDatabaseThatMustNotBeTouched(new Error('unused')),
      clock,
      log,
      userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
      attention: nobodyActive,
    });
    lifecycle.close(
      {
        id: 's9',
        raw: Object.assign({ send: (): number => 0 }, { getBufferedAmount: (): number => 0 }),
        data: { request: new Request('https://purlay.test/ws') },
        close: () => undefined,
      },
      1000,
    );
    expect(lines.find((line) => line['msg'] === 'socket closed')).toMatchObject({
      socketId: 's9',
      closeCode: 1000,
      frames: 0,
      peakPerSecond: 0,
      refused: 0,
    });
  });
});

describe('who is online, in a process that does not run chat', () => {
  const lifecycleWith = (
    closedEvent?: (event: string) => boolean,
  ): ReturnType<typeof createSocketLifecycle> => {
    const { log } = aRecordingLogger();
    const dependencies: SocketDependencies = {
      config: testConfig(),
      auth: anAuthThatMustNotBeTouched(),
      database: aDatabaseThatMustNotBeTouched(),
      clock,
      log,
      userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
      attention: nobodyActive,
      ...(closedEvent === undefined ? {} : { closedEvent }),
    };
    return createSocketLifecycle(dependencies);
  };

  test('is nobody, when the news of presence is closed: the node counts none and tells none', () => {
    const lifecycle = lifecycleWith((event) => event === 'PRESENCE');
    expect(lifecycle.online).toBe(offlinePresence);
  });

  test('is counted as before where presence is open, and where another event only is closed', () => {
    for (const closedEvent of [undefined, (event: string): boolean => event === 'TYPING']) {
      const lifecycle = lifecycleWith(closedEvent);
      expect(lifecycle.online).not.toBe(offlinePresence);
      lifecycle.online.stop();
    }
  });
});
