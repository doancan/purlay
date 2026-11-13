import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { AppErrorBody, ERROR_STATUS, statusFor, type ErrorCode } from './errors';

const codes = Object.keys(ERROR_STATUS) as ErrorCode[];

test('workspace access refusal optionally names one validated canonical workspace', () => {
  const refusal = { code: 'WORKSPACE_ACCESS_REQUIRED', message: 'Verify first.' };
  expect(Value.Check(AppErrorBody, refusal)).toBe(true);
  expect(
    Value.Check(AppErrorBody, {
      ...refusal,
      details: { workspaceId: '00000000-0000-4000-8000-0000000000a1' },
    }),
  ).toBe(true);
  for (const details of [
    {},
    { workspaceId: null },
    { workspaceId: 'foreign/slug' },
    { workspaceId: 1 },
  ]) {
    expect(Value.Check(AppErrorBody, { ...refusal, details })).toBe(false);
  }
});
/**
 * The statuses `API.md` §1 tabulates, read from its table rather than copied —
 * the copy that was here listed one the table did not (#201). Every status a
 * code produces must be among them.
 */
const allowed: readonly number[] = [
  ...readFileSync('docs/API.md', 'utf8').matchAll(/^\| `(\d{3})` \|/gm),
].map((match) => Number(match[1]));

describe('the error contract', () => {
  test('workspace remediation distinguishes stale state, invalid proof, absence and lockout', () => {
    expect(statusFor('WORKSPACE_ACCESS_REQUIRED')).toBe(403);
    expect(statusFor('WORKSPACE_SECURITY_CHANGED')).toBe(409);
    expect(statusFor('WORKSPACE_SECURITY_NOT_READY')).toBe(409);
    expect(statusFor('WORKSPACE_MFA_NOT_FOUND')).toBe(404);
    expect(statusFor('WORKSPACE_MFA_INVALID')).toBe(400);
    expect(statusFor('WORKSPACE_MFA_LOCKED')).toBe(429);
  });

  test('every code has a status, and it is one API.md allows', () => {
    expect(codes.length).toBeGreaterThan(0);
    // The table was read: a pattern that matched nothing would allow nothing and
    // fail below, but for the wrong reason.
    expect(allowed).toContain(404);
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
