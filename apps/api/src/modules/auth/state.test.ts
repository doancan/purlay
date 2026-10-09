/**
 * The `state` check is the whole CSRF defence of the sign-in.
 *
 * Without it the callback signs a victim into the attacker's account, so every
 * way it can be defeated gets a test: a forged signature, a tampered payload, a
 * replayed-but-expired cookie, a cookie that does not match what came back, and
 * a signature made with a different root secret.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { issueState, verifyState } from './state';

const KEY = DEVELOPMENT_ENCRYPTION_KEY;
const OTHER_KEY = 'YW5vdGhlci1kZXZlbG9wbWVudC1vbmx5LWtleS0zMi1ieQ==';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const at = (minutes: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + minutes * 60_000));

describe('the OAuth state', () => {
  test('a handshake it issued, it accepts', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(1), cookieValue, state)).toBe(true);
  });

  test('two handshakes never share a state', async () => {
    const first = await issueState(KEY, at(0));
    const second = await issueState(KEY, at(0));
    expect(first.state).not.toBe(second.state);
    expect(first.state).toHaveLength(32);
  });

  /**
   * The attack the signature exists for: a sibling subdomain can write a cookie
   * for this origin, so an attacker who controls both halves of the handshake
   * could otherwise sign a victim in as themselves.
   */
  test('a cookie the attacker wrote is refused, because they cannot sign it', async () => {
    const forged = `deadbeefdeadbeefdeadbeefdeadbeef.${String(NOW.getTime() + 600_000)}.0000`;
    expect(await verifyState(KEY, at(0), forged, 'deadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  test('a signature from a different root secret is refused', async () => {
    const { state, cookieValue } = await issueState(OTHER_KEY, at(0));
    expect(await verifyState(KEY, at(0), cookieValue, state)).toBe(false);
  });

  test('changing the payload invalidates the signature', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    const [, expiresAt, signature] = cookieValue.split('.') as [string, string, string];
    const tampered = `ffffffffffffffffffffffffffffffff.${expiresAt}.${signature}`;
    expect(await verifyState(KEY, at(0), tampered, state)).toBe(false);
    // And pushing the expiry out is tampering too, not a loophole.
    const extended = `${state}.${String(Number(expiresAt) + 3_600_000)}.${signature}`;
    expect(await verifyState(KEY, at(0), extended, state)).toBe(false);
  });

  test('it expires', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(9), cookieValue, state)).toBe(true);
    expect(await verifyState(KEY, at(11), cookieValue, state)).toBe(false);
  });

  test('a valid cookie with the wrong state is refused', async () => {
    const { cookieValue } = await issueState(KEY, at(0));
    const other = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(0), cookieValue, other.state)).toBe(false);
  });

  test('a missing half is refused rather than assumed', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(0), undefined, state)).toBe(false);
    expect(await verifyState(KEY, at(0), cookieValue, undefined)).toBe(false);
    expect(await verifyState(KEY, at(0), 'not-a-cookie', state)).toBe(false);
    expect(await verifyState(KEY, at(0), '', state)).toBe(false);
  });
});
