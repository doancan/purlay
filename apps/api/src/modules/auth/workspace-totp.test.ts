/** Authenticator interoperability is checked against RFC vectors and our independent test app. */
import { expect, test } from 'bun:test';
import { aWrongCode, codeAt, keyOf } from '../../testing/totp';
import { createWorkspaceTotp, matchingWorkspaceTotpCounter } from './workspace-totp';

const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
// RFC 6238 Appendix B SHA-1 values, reduced to the six digits the authenticator displays.
// https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B
test.each([
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
] as const)('finds the accepted timestep for RFC time %i', async (seconds, code) => {
  expect(await matchingWorkspaceTotpCounter(RFC_SECRET, code, new Date(seconds * 1_000))).toBe(
    Math.floor(seconds / 30),
  );
});

test('new setup preserves its random secret through an escaped authenticator URI', async () => {
  const account = 'Şirket / İstanbul:user+name@example.test';
  const first = createWorkspaceTotp(account);
  const second = createWorkspaceTotp(account);
  const uri = new URL(first.uri);
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.hostname).toBe('totp');
  expect(decodeURIComponent(uri.pathname)).toBe(`/Purlay:${account}`);
  expect(uri.searchParams.get('issuer')).toBe('Purlay');
  expect(uri.searchParams.get('digits')).toBe('6');
  expect(uri.searchParams.get('period')).toBe('30');
  expect(first.secret.byteLength).toBe(32);
  expect(first.secret).not.toEqual(second.secret);
  expect(keyOf(first.uri)).toEqual(Buffer.from(first.secret));
  const now = new Date('2026-11-12T12:00:00.000Z');
  const code = codeAt(keyOf(first.uri), now.getTime());
  expect(await matchingWorkspaceTotpCounter(first.secret, code, now)).toBe(
    Math.floor(now.getTime() / 30_000),
  );
});

test('accepts only this period and one adjacent period, returning the exact counter', async () => {
  const now = new Date('2026-11-12T12:00:00.000Z');
  const key = Buffer.from(RFC_SECRET);
  const counter = Math.floor(now.getTime() / 30_000);
  for (const step of [-1, 0, 1]) {
    expect(await matchingWorkspaceTotpCounter(key, codeAt(key, now.getTime(), step), now)).toBe(
      counter + step,
    );
  }
  for (const step of [-2, 2]) {
    expect(
      await matchingWorkspaceTotpCounter(key, codeAt(key, now.getTime(), step), now),
    ).toBeNull();
  }
  expect(await matchingWorkspaceTotpCounter(key, aWrongCode(key, now.getTime()), now)).toBeNull();
});

test.each(['', '28708', '2870820', ' 287082', '287082\n', '２８７０８２', '28x082'])(
  'refuses malformed code %j without coercing or trimming it',
  async (code) => {
    expect(await matchingWorkspaceTotpCounter(RFC_SECRET, code, new Date(59_000))).toBeNull();
  },
);

test('uses the supplied clock on the period boundary, including the first epoch step', async () => {
  // RFC 4226 Appendix D, counters zero and one.
  expect(await matchingWorkspaceTotpCounter(RFC_SECRET, '755224', new Date(0))).toBe(0);
  expect(await matchingWorkspaceTotpCounter(RFC_SECRET, '287082', new Date(30_000))).toBe(1);
  expect(await matchingWorkspaceTotpCounter(RFC_SECRET, '755224', new Date(59_999))).toBe(0);
  expect(await matchingWorkspaceTotpCounter(RFC_SECRET, '755224', new Date(60_000))).toBeNull();
});

test.each([new Date(Number.NaN), new Date(-1)])(
  'refuses an invalid verification clock',
  async (now) => {
    expect(await matchingWorkspaceTotpCounter(RFC_SECRET, '755224', now)).toBeNull();
  },
);
