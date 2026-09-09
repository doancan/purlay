import { describe, expect, test } from 'bun:test';
import { ERROR_STATUS, statusFor, type ErrorCode } from './errors';

const codes = Object.keys(ERROR_STATUS) as ErrorCode[];
/**
 * Not a second list of the statuses this API may return — that is `HttpStatus`
 * itself, and a copy here would be the drift `CONTRIBUTING.md` §6.1 forbids.
 * These are the ones `API.md` §1 tabulates, and the test below is that every
 * status a code produces is among them.
 */
const allowed: readonly number[] = [400, 401, 403, 404, 409, 413, 429, 500];

describe('the error contract', () => {
  test('every code has a status, and it is one API.md allows', () => {
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(allowed).toContain(statusFor(code));
    }
  });

  /**
   * D-21 is the reason this test exists. A 403 confirms the resource exists,
   * which is itself a disclosure, so a boundary resolves to absence rather than
   * refusal. Enforcing it here means the wrong status cannot be chosen at a call
   * site, because the code the call site raises already fixes it.
   */
  test('absence is 404 — a boundary never answers 403 (D-21, D-34)', () => {
    const absence = codes.filter((code) => code.endsWith('_NOT_FOUND'));
    expect(absence.length).toBeGreaterThan(0);
    for (const code of absence) {
      expect(statusFor(code)).toBe(404);
    }
  });

  test('403 is reserved for a resource the caller can already see', () => {
    const forbidden = codes.filter((code) => statusFor(code) === 403);
    for (const code of forbidden) {
      expect(code.endsWith('_NOT_FOUND')).toBe(false);
    }
  });

  test('a conflict is 409, including the message id collision (D-33)', () => {
    expect(statusFor('MESSAGE_ID_CONFLICT')).toBe(409);
    expect(statusFor('ACCOUNT_EMAIL_CONFLICT')).toBe(409);
  });

  test('codes are SCREAMING_SNAKE_CASE, so they read the same everywhere', () => {
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
