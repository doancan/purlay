/**
 * Before a delivery to the GitHub App's address is believed (D-246 §1, as `webhooks.test.ts` for a feed's): an
 * address past its bucket is refused before anything is looked at, a node already reading as many as it will is
 * refused, a body too slow to arrive is refused at its deadline — each said in the log, none touching the
 * database — and without an App there is no address at all.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { GITHUB_APP_STUB } from '../../testing/github-app-stub';
import { githubAppApi, githubAppCaller } from '../../modules/integrations/github-app-api';
import { DELIVERIES_AT_ONCE } from './webhooks';
import { receiveAppWebhook } from './github-app';

const attempt = async (
  over: {
    readonly mayKnock?: boolean;
    readonly inFlight?: number;
    readonly app?: boolean;
    readonly deadline?: () => Promise<void>;
  } = {},
): Promise<{ code: string; inFlight: number; lines: Record<string, unknown>[] }> => {
  const { log, lines } = aRecordingLogger();
  const inFlight = { count: over.inFlight ?? 0 };
  // A body that never ends: only the deadline can finish its read.
  const request = new Request('https://purlay.test/api/webhooks/github-app', {
    method: 'POST',
    body: new ReadableStream({ start: (): undefined => undefined }),
    // A streamed body needs half-duplex, which the platform's `Request` takes as an option.
    duplex: 'half',
  });
  const dependencies = testDependencies();
  const code = await receiveAppWebhook(
    {
      auth: dependencies.auth,
      // A database that fails loudly if anything touches it: nothing may be looked up here.
      database: dependencies.database,
      clock: dependencies.clock,
      log,
      cipher: {
        seal: () => Promise.reject(new Error('unused')),
        open: () => Promise.reject(new Error('unused')),
      },
      bus: {
        publish: () => Promise.resolve(),
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      },
      app: over.app === false ? undefined : GITHUB_APP_STUB,
      api: githubAppApi(
        githubAppCaller(
          () => Promise.reject(new Error('unused')),
          () => new Date(),
        ),
        { web: 'https://github.example', api: 'https://api.github.example' },
      ),
      urls: { web: 'https://github.example', api: 'https://api.github.example' },
      appUrl: 'https://purlay.test',
      mayKnock: () => Promise.resolve(over.mayKnock ?? true),
      inFlight,
      deadline: over.deadline ?? ((): Promise<void> => new Promise<void>(() => undefined)),
    },
    request,
    '203.0.113.7',
  ).then(
    () => 'accepted',
    (error: unknown) =>
      error !== null && typeof error === 'object' && 'body' in error
        ? (error as { body: { code: string } }).body.code
        : String(error),
  );
  return { code, inFlight: inFlight.count, lines };
};

describe('before a delivery to the App is read', () => {
  test('an address past its bucket is refused before anything is looked at, and said', async () => {
    const { code, lines } = await attempt({ mayKnock: false });
    expect(code).toBe('RATE_LIMITED');
    expect(lines.map((line) => line['outcome'])).toEqual(['knocked_too_often']);
  });

  test('without an App there is no such address', async () => {
    expect((await attempt({ app: false })).code).toBe('ROUTE_NOT_FOUND');
  });

  test('a node reading as many as it will refuses one more, and its count is not moved', async () => {
    const { code, inFlight, lines } = await attempt({ inFlight: DELIVERIES_AT_ONCE });
    expect([code, inFlight]).toEqual(['RATE_LIMITED', DELIVERIES_AT_ONCE]);
    expect(lines.map((line) => line['outcome'])).toEqual(['node_busy']);
  });

  test('a body too slow to arrive is refused at its deadline, and the count comes back', async () => {
    const { code, inFlight } = await attempt({ deadline: () => Promise.resolve() });
    expect([code, inFlight]).toEqual(['RATE_LIMITED', 0]);
  });
});
