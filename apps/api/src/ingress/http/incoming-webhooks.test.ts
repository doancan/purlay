/**
 * Before an incoming webhook is looked up (D-245): an address past its bucket is refused before anything
 * else, and said without the address that was tried; a body the contract refuses is refused before a hook
 * is looked up. What needs a hook to be there is `incoming-webhooks.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { postIncomingWebhook } from './incoming-webhooks';

const SECRET = 'c'.repeat(64);

const attempt = async (
  mayKnock: boolean,
  body: unknown,
): Promise<{ code: string; lines: Record<string, unknown>[] }> => {
  const { log, lines } = aRecordingLogger();
  const code = await postIncomingWebhook(
    {
      // A database that fails loudly if anything touches it: nothing may be looked up here.
      ...testDependencies(),
      log,
      bus: {
        publish: () => Promise.resolve(),
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      },
      mayPost: () => Promise.reject(new Error('no hook’s bucket may be charged here')),
      mayKnock: () => Promise.resolve(mayKnock),
    },
    { webhookId: crypto.randomUUID(), secret: SECRET },
    body,
    '203.0.113.7',
  ).then(
    () => 'accepted',
    (error: unknown) =>
      error !== null && typeof error === 'object' && 'body' in error
        ? (error as { body: { code: string } }).body.code
        : String(error),
  );
  return { code, lines };
};

describe('before an incoming webhook is looked up', () => {
  test('an address past its bucket is refused before anything else, and said without the secret', async () => {
    const { code, lines } = await attempt(false, { text: 'hello' });
    expect(code).toBe('RATE_LIMITED');
    expect(lines.map((line) => line['outcome'])).toEqual(['knocked_too_often']);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  test('a body the contract refuses is refused before a hook is looked up', async () => {
    expect((await attempt(true, { text: 'hello', attachments: [] })).code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await attempt(true, null)).code).toBe('VALIDATION_FAILED');
  });
});
