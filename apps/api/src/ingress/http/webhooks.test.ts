/**
 * Before a delivery is read (D-134 §4): an address past its bucket is refused before anything is
 * looked up, and an address naming no feed before a byte is read. What needs a feed to be there —
 * the node's few reads at once, a read too slow — is `webhooks.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { receiveWebhook } from './webhooks';

const attempt = async (
  mayKnock: boolean,
  feedId: string,
): Promise<{ code: string; read: boolean; lines: Record<string, unknown>[] }> => {
  let read = false;
  const request = {
    arrayBuffer: () => {
      read = true;
      return Promise.resolve(new ArrayBuffer(0));
    },
    headers: new Headers(),
  } as unknown as Request;
  const { log, lines } = aRecordingLogger();
  const code = await receiveWebhook(
    {
      // A database that fails loudly if anything touches it: nothing may be looked up here.
      ...testDependencies(),
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
      mayDeliver: () => Promise.resolve(true),
      mayKnock: () => Promise.resolve(mayKnock),
      inFlight: { count: 0 },
      deadline: () => new Promise<void>(() => undefined),
    },
    request,
    feedId,
    '203.0.113.7',
  ).then(
    () => 'accepted',
    (error: unknown) =>
      error !== null && typeof error === 'object' && 'body' in error
        ? (error as { body: { code: string } }).body.code
        : String(error),
  );
  return { code, read, lines };
};

describe('before a delivery is read', () => {
  test('an address past its bucket is refused before anything is looked up, and said', async () => {
    const { code, read, lines } = await attempt(false, crypto.randomUUID());
    expect([code, read]).toEqual(['RATE_LIMITED', false]);
    expect(lines.map((line) => line['outcome'])).toEqual(['knocked_too_often']);
  });

  test('an address that names no feed at all is not found, and nothing is read', async () => {
    expect(await attempt(true, 'not-a-uuid')).toMatchObject({
      code: 'GITHUB_FEED_NOT_FOUND',
      read: false,
    });
  });
});
