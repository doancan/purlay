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
import {
  connectIntentOf,
  issueConnectState,
  issueState,
  verifyConnectState,
  verifyState,
} from './state';

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

  /**
   * The comparison walks the length of its first argument, so without the length
   * check a value that is a *prefix* of the right one compares equal — and the empty
   * string is a prefix of everything. An attacker who can write the cookie would
   * need no signature at all.
   */
  test('a signature that is only the start of the right one is refused, the empty one included', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    const [, expiresAt, signature] = cookieValue.split('.') as [string, string, string];
    expect(await verifyState(KEY, at(0), cookieValue, state)).toBe(true);
    for (const cut of [0, 1, 16, signature.length - 1]) {
      const truncated = `${state}.${expiresAt}.${signature.slice(0, cut)}`;
      expect(await verifyState(KEY, at(0), truncated, state)).toBe(false);
    }
  });

  test('a returned state that is only the start of the right one is refused', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(0), cookieValue, state.slice(0, 31))).toBe(false);
    expect(await verifyState(KEY, at(0), cookieValue, '')).toBe(false);
    expect(await verifyState(KEY, at(0), cookieValue, `${state}0`)).toBe(false);
  });

  test('a missing half is refused rather than assumed', async () => {
    const { state, cookieValue } = await issueState(KEY, at(0));
    expect(await verifyState(KEY, at(0), undefined, state)).toBe(false);
    expect(await verifyState(KEY, at(0), cookieValue, undefined)).toBe(false);
    expect(await verifyState(KEY, at(0), 'not-a-cookie', state)).toBe(false);
    expect(await verifyState(KEY, at(0), '', state)).toBe(false);
  });
});

describe('the state of a connect (D-176)', () => {
  const INTENT = {
    userId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    sessionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
    workspace: 'acme-eng',
  };

  test('names who asked, from which session, and where to come back to', async () => {
    const { state, cookieValue } = await issueConnectState(KEY, at(0), INTENT);
    expect(await verifyConnectState(KEY, at(1), cookieValue, state)).toEqual(INTENT);
    expect(await connectIntentOf(KEY, cookieValue)).toEqual(INTENT);
  });

  test('a sign-in’s cookie is never a connect’s, nor a connect’s a sign-in’s', async () => {
    const signIn = await issueState(KEY, at(0));
    expect(await verifyConnectState(KEY, at(0), signIn.cookieValue, signIn.state)).toBeUndefined();
    expect(await connectIntentOf(KEY, signIn.cookieValue)).toBeUndefined();
    const connect = await issueConnectState(KEY, at(0), INTENT);
    expect(await verifyState(KEY, at(0), connect.cookieValue, connect.state)).toBe(false);
    // Shaped as a connect, signed as a sign-in: the keys are not the same key.
    const [, , , , , , signature] = connect.cookieValue.split('.');
    const payload = connect.cookieValue.slice(0, -1 - (signature ?? '').length);
    const asSignIn = await issueState(KEY, at(0));
    const crossed = `${payload}.${asSignIn.cookieValue.split('.')[2] ?? ''}`;
    expect(await connectIntentOf(KEY, crossed)).toBeUndefined();
  });

  test('another person, another session or another page is not what was signed', async () => {
    const { state, cookieValue } = await issueConnectState(KEY, at(0), INTENT);
    for (const [from, to] of [
      [INTENT.userId, INTENT.sessionId],
      [INTENT.sessionId, INTENT.userId],
      ['acme-eng', 'evil'],
    ] as const) {
      const rewritten = cookieValue.replace(from, to);
      expect(rewritten).not.toBe(cookieValue);
      expect(await verifyConnectState(KEY, at(0), rewritten, state)).toBeUndefined();
      expect(await connectIntentOf(KEY, rewritten)).toBeUndefined();
    }
    const other = await issueConnectState(OTHER_KEY, at(0), INTENT);
    expect(await connectIntentOf(KEY, other.cookieValue)).toBeUndefined();
  });

  test('it expires, and it must be the state GitHub was given; where to return outlives both', async () => {
    const { state, cookieValue } = await issueConnectState(KEY, at(0), INTENT);
    expect(await verifyConnectState(KEY, at(11), cookieValue, state)).toBeUndefined();
    expect(await verifyConnectState(KEY, at(0), cookieValue, 'f'.repeat(32))).toBeUndefined();
    expect(await verifyConnectState(KEY, at(0), cookieValue, undefined)).toBeUndefined();
    expect(await verifyConnectState(KEY, at(0), undefined, state)).toBeUndefined();
    expect(await connectIntentOf(KEY, cookieValue)).toEqual(INTENT);
    expect(await connectIntentOf(KEY, undefined)).toBeUndefined();
  });

  test('a value that would not survive the cookie’s shape is refused before it is signed', async () => {
    for (const bad of [
      { ...INTENT, workspace: 'a.b' },
      { ...INTENT, workspace: '//evil.example' },
      { ...INTENT, userId: 'not-a-uuid' },
      { ...INTENT, sessionId: `${INTENT.sessionId}.x` },
    ]) {
      const refusal = await issueConnectState(KEY, at(0), bad).then(
        () => 'signed',
        (error: unknown) => String(error),
      );
      expect(refusal).toContain('a connect intent must name');
    }
  });
});
