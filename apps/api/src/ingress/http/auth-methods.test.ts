/**
 * How this server signs people in, asked before anybody is (#81, D-138 §6): GitHub always, email only
 * with both of `SMTP_URL` and `MAIL_FROM`. Answered without a session and without the database — the
 * app below has one that fails any use, so a read of it would fail the test.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { AuthMethods } from '@purlay/types';
import { testConfig, testDependencies } from '../../testing/doubles';
import { createApp } from './app';

const ask = async (config: ReturnType<typeof testConfig>): Promise<[number, unknown]> => {
  const app = createApp(testDependencies({ config }));
  const response = await app.handle(new Request('https://purlay.test/api/auth/methods'));
  return [response.status, await response.json()];
};

describe('the ways in', () => {
  test('without mail configured, GitHub alone; with it, email too — for anybody, signed in or not', async () => {
    expect(await ask(testConfig())).toEqual([200, { email: false }]);
    const [status, body] = await ask(
      testConfig({ SMTP_URL: 'smtps://u:p@mail.example.com', MAIL_FROM: 'purlay@example.com' }),
    );
    expect(status).toBe(200);
    expect(Value.Check(AuthMethods, body)).toBe(true);
    expect(body).toEqual({ email: true });
  });
});
