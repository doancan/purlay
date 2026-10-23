/**
 * The secret demo sessions are signed with is the scratch server's, not the environment's: a `.env`
 * on the machine names an `ENCRYPTION_KEY` the scratch server never sees, and a session signed with it
 * is refused (`401`) — the demo's login led to the sign-in screen, and nothing said why.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { deriveAuthSecret } from '../modules/auth/better-auth';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { demoSecret } from './demo-seed';

const before = process.env['ENCRYPTION_KEY'];
afterEach(() => {
  if (before === undefined) delete process.env['ENCRYPTION_KEY'];
  else process.env['ENCRYPTION_KEY'] = before;
});

describe('the secret of a scratch server', () => {
  test('is the development key’s, whatever this process’s environment names', () => {
    const expected = deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY);
    delete process.env['ENCRYPTION_KEY'];
    expect(demoSecret()).toBe(expected);
    process.env['ENCRYPTION_KEY'] = 'cmFuZG9tLWtleS1ub3QtdGhlLWRldmVsb3BtZW50LW9uZQ==';
    expect(demoSecret()).toBe(expected);
  });
});
