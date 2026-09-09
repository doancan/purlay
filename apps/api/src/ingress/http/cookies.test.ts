/**
 * The cookie's attributes are the security property, so they are asserted rather
 * than trusted. A missing `HttpOnly` is invisible until an injection reads a
 * session, and a mismatched attribute on the cleared cookie leaves the original
 * in place, so signing out does nothing.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_COOKIE, clearedSessionCookie, sessionCookie, sessionTokenFrom } from './cookies';

const expiresAt = new Date('2026-10-09T08:00:00.000Z');

describe('the session cookie', () => {
  const cookie = sessionCookie({ token: 'a-token', expiresAt });

  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    test(`carries ${attribute}`, () => {
      expect(cookie).toContain(attribute);
    });
  }

  test('carries the token and its expiry', () => {
    expect(cookie).toContain(`${SESSION_COOKIE}=a-token`);
    expect(cookie).toContain('Expires=Fri, 09 Oct 2026 08:00:00 GMT');
  });

  /**
   * A browser keys a cookie on name, domain and path. If the cleared cookie
   * differs in any of them it becomes a *second* cookie and the session survives
   * the sign-out — silently, which is the worst way for a sign-out to fail.
   */
  test('the cleared cookie matches on everything a browser keys on', () => {
    const cleared = clearedSessionCookie();
    const attributesOf = (value: string): string[] =>
      value
        .split('; ')
        .slice(1)
        .filter((part) => !part.startsWith('Expires='))
        .sort();
    expect(attributesOf(cleared)).toEqual(attributesOf(cookie));
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(new Date(cleared.split('Expires=')[1] ?? '').getTime()).toBeLessThan(Date.now());
  });
});

describe('reading the token back', () => {
  test('finds it among other cookies, wherever it sits', () => {
    expect(sessionTokenFrom(`theme=dark; ${SESSION_COOKIE}=abc; locale=tr`)).toBe('abc');
    expect(sessionTokenFrom(`${SESSION_COOKIE}=abc`)).toBe('abc');
  });

  test('is not fooled by a cookie whose name merely ends the same way', () => {
    expect(sessionTokenFrom(`not_${SESSION_COOKIE}=abc`)).toBeUndefined();
    expect(sessionTokenFrom(`${SESSION_COOKIE}_old=abc`)).toBeUndefined();
  });

  test('an absent, empty or malformed header is nothing, never a guess', () => {
    expect(sessionTokenFrom(null)).toBeUndefined();
    expect(sessionTokenFrom('')).toBeUndefined();
    expect(sessionTokenFrom(`${SESSION_COOKIE}=`)).toBeUndefined();
    expect(sessionTokenFrom('nonsense')).toBeUndefined();
  });
});
