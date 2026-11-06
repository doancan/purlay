/**
 * A module's frame handlers, with a module that is not chat (D-276): `notes` owns an operation and serves it with a handler of
 * its slot, and the router serves it as it serves any module's. What is the same for every module is what is held here — the
 * connection's budget before the handler, the module's deadline and share around it, an operation of a module that is not run
 * answered as one nobody has — beside the composition's rules for what a module may supply.
 */
import { nobodyActive } from '../platform/attention';
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { compose, type BundledModule } from '../composition';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../testing/doubles';
import { AppError } from '../platform/errors';
import { fixedClock } from '../platform/clock';
import type { FrameHandlers } from '../platform/frame-handlers';
import { createLogger, withinRequest, type RequestScope } from '../platform/logging';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { inProcessEventBus } from './bus';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET, type RateLimiter } from './rate-limiter';
import { routeFrame, type RouterFrameContext } from './router';

const clock = fixedClock(new Date('2026-11-06T12:00:00.000Z'));
const FRAME_ID = '00000000-0000-7000-8000-0000000000a1';
const CHANNEL_ID = '00000000-0000-4000-8000-000000000000';
const IDENTITY = { socketId: 's1', userId: 'u1', sessionId: 'not-read', expiresAt: clock.now() };

/** The operation is one the contract has: a module's own operation is a name the contract opens to it (`MODULES.md` §4). */
const OPERATION = 'TYPING';

const notesWith = (frameHandlers: FrameHandlers<RouterFrameContext>): BundledModule => ({
  manifest: {
    id: 'notes',
    requires: [],
    optional: [],
    provides: [],
    budget: { none: 'a test module' },
    frames: [OPERATION],
  },
  frameHandlers,
});

const frameOf = (): unknown => ({
  id: FRAME_ID,
  op: OPERATION,
  payload: { channelId: CHANNEL_ID },
});

const route = async (
  running: readonly BundledModule[],
  options: {
    readonly limiter?: RateLimiter;
    readonly scope?: RequestScope;
    readonly deadlineMs?: number;
    readonly bundled?: readonly BundledModule[];
  } = {},
): Promise<{
  readonly replies: readonly ServerFrame[];
  readonly lines: readonly Record<string, unknown>[];
}> => {
  const composition = compose(running, options.bundled ?? running);
  const { log, lines } = aRecordingLogger();
  const replies = await withinRequest(
    options.scope ?? { requestId: 'frame-1', startedAt: 0 },
    async () =>
      await routeFrame(
        {
          database: aDatabaseThatMustNotBeTouched(),
          clock,
          bus: inProcessEventBus(() => undefined, createLogger({ level: 'silent' })),
          limiter: options.limiter ?? inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          presence: inMemoryPresenceRegistry(clock),
          attention: nobodyActive,
          online: { active: () => undefined },
          sessionLifetime: () => NO_SESSION_LIFETIME,
          log,
          socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
          atomically: async () => await Promise.reject(new Error('no transaction here')),
          frameHandlers: composition.frameHandlers,
          closedFrame: composition.closedFrame,
          moduleOfFrame: (op) => (op === OPERATION ? 'notes' : undefined),
          ...(options.deadlineMs === undefined
            ? {}
            : {
                deadlineOf: (module: string): number | undefined =>
                  module === 'notes' ? options.deadlineMs : undefined,
              }),
        },
        IDENTITY,
        frameOf(),
      ),
  );
  return { replies, lines };
};

describe('a frame of a module that runs', () => {
  test('is served by the module’s handler, which is given the connection’s context and answers with the router’s helpers', async () => {
    const seen: string[] = [];
    const scope: RequestScope = { requestId: 'frame-2', startedAt: 0 };
    const { replies } = await route(
      [
        notesWith({
          [OPERATION]: (context, frame) => {
            seen.push(`${context.identity.userId}:${frame.payload.channelId}`);
            return Promise.resolve([context.reply({ event: 'PONG', data: {} }, frame.id)]);
          },
        }),
      ],
      { scope },
    );
    expect(seen).toEqual([`u1:${CHANNEL_ID}`]);
    expect(replies).toEqual([
      { event: 'PONG', data: {}, ts: clock.now().getTime(), refId: FRAME_ID },
    ]);
    // Noted as the module's, so that what it asks of the database is its share's.
    expect(scope.module).toBe('notes');
  });

  test('is answered with the frame’s refId when its handler fails, by what the failure is', async () => {
    const refused = await route([
      notesWith({
        [OPERATION]: () =>
          Promise.reject(new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'No such channel.' })),
      }),
    ]);
    expect(refused.replies).toEqual([
      {
        event: 'ERROR',
        data: { code: 'CHANNEL_NOT_FOUND', message: 'No such channel.' },
        ts: clock.now().getTime(),
        refId: FRAME_ID,
      },
    ]);

    const broken = await route([
      notesWith({ [OPERATION]: () => Promise.reject(new Error('the cause')) }),
    ]);
    expect(broken.replies).toEqual([
      {
        event: 'ERROR',
        data: { code: 'INTERNAL', message: 'Something went wrong.' },
        ts: clock.now().getTime(),
        refId: FRAME_ID,
      },
    ]);
    expect(broken.lines.find((line) => line['msg'] === 'frame failed')).toMatchObject({
      level: 'error',
      op: OPERATION,
    });
  });

  test('is counted against the connection’s budget before the handler is asked, and refused over it', async () => {
    let asked = 0;
    const limiter: RateLimiter = {
      consume: () => Promise.resolve(false),
      forget: () => undefined,
    };
    const { replies } = await route(
      [
        notesWith({
          [OPERATION]: () => {
            asked += 1;
            return Promise.resolve([]);
          },
        }),
      ],
      { limiter },
    );
    expect(asked).toBe(0);
    expect(replies).toMatchObject([
      { event: 'ERROR', data: { code: 'RATE_LIMITED' }, refId: FRAME_ID },
    ]);
  });

  test('is held to the module’s deadline: answered REQUEST_TIMEOUT, and what the handler asked for is cancelled', async () => {
    const scope: RequestScope = { requestId: 'frame-3', startedAt: 0 };
    const { replies, lines } = await route(
      [notesWith({ [OPERATION]: () => new Promise<never>(() => undefined) })],
      { scope, deadlineMs: 20 },
    );
    expect(replies).toMatchObject([
      { event: 'ERROR', data: { code: 'REQUEST_TIMEOUT' }, refId: FRAME_ID },
    ]);
    expect(scope.signal?.aborted).toBe(true);
    expect(lines.find((line) => line['msg'] === 'frame ran past its deadline')).toMatchObject({
      module: 'notes',
      op: OPERATION,
    });
  });
});

describe('a frame of a module that is not run', () => {
  test('is answered as an operation nobody has, and its handler is never asked', async () => {
    let asked = 0;
    const notes = notesWith({
      [OPERATION]: () => {
        asked += 1;
        return Promise.resolve([]);
      },
    });
    const { replies } = await route([], { bundled: [notes] });
    expect(asked).toBe(0);
    expect(replies).toMatchObject([
      {
        event: 'ERROR',
        data: {
          code: 'VALIDATION_FAILED',
          details: { fields: { op: 'is not an operation this server accepts' } },
        },
        refId: FRAME_ID,
      },
    ]);
  });
});

describe('the handlers a composition takes', () => {
  test('are those of the modules that run, and of no other', () => {
    const handler: FrameHandlers<RouterFrameContext> = { [OPERATION]: () => Promise.resolve([]) };
    const notes = notesWith(handler);
    expect(Object.keys(compose([notes], [notes]).frameHandlers)).toEqual([OPERATION]);
    expect(Object.keys(compose([], [notes]).frameHandlers)).toEqual([]);
  });

  test('stop the build for an operation the module’s manifest does not name', () => {
    const notes = notesWith({
      [OPERATION]: () => Promise.resolve([]),
      MESSAGE_SEND: () => Promise.resolve([]),
    });
    expect(() => compose([notes], [notes])).toThrow(
      '"notes" supplies handlers for MESSAGE_SEND, which its manifest does not name under frames',
    );
  });

  test('stop the build for an operation the module names and has no handler for', () => {
    const notes = notesWith({});
    expect(() => compose([notes], [notes])).toThrow(
      `"notes" names the frames ${OPERATION} in its manifest and supplies no handler for them`,
    );
  });
});
