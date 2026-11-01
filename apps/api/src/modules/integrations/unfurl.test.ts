/**
 * What GitHub's answers to the workspace's token mean (D-23, amended; #884): a `401` is the token
 * being bad, a `403` or `429` that says when to return is the quota being spent until then, and
 * nothing else is a refusal. The rule is a function of the status, three headers and the time, so it
 * is decided here without a server; the calls that act on it are `unfurl.resilience.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { broadScopes } from './github';
import { inProcessPauses, refusalOf } from './unfurl';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const answer = (
  status: number,
  headers: Record<string, string> = {},
): Parameters<typeof refusalOf>[0] => ({
  status,
  headers: new Headers(headers),
});

describe('what a response says of the token', () => {
  test('401 is a token that is bad, whatever else it says', () => {
    expect(refusalOf(answer(401), NOW)).toEqual({ kind: 'token_invalid' });
    expect(refusalOf(answer(401, { 'retry-after': '30' }), NOW)).toEqual({ kind: 'token_invalid' });
  });

  test('a primary limit is waited out until it resets: 403, remaining 0, a reset time', () => {
    const reset = String((NOW + 20 * 60 * 1000) / 1000);
    expect(
      refusalOf(answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), NOW),
    ).toEqual({ kind: 'rate_limited', resumesAt: NOW + 20 * 60 * 1000 });
  });

  test('a secondary limit is waited out for Retry-After, in seconds or as a date', () => {
    expect(refusalOf(answer(403, { 'retry-after': '90' }), NOW)).toEqual({
      kind: 'rate_limited',
      resumesAt: NOW + 90_000,
    });
    expect(
      refusalOf(answer(429, { 'retry-after': new Date(NOW + 45_000).toUTCString() }), NOW),
    ).toEqual({ kind: 'rate_limited', resumesAt: NOW + 45_000 });
  });

  test('Retry-After wins over a reset time, and a reset with quota left is no limit', () => {
    const reset = String((NOW + 600_000) / 1000);
    expect(
      refusalOf(
        answer(429, {
          'retry-after': '10',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': reset,
        }),
        NOW,
      ),
    ).toEqual({ kind: 'rate_limited', resumesAt: NOW + 10_000 });
    expect(
      refusalOf(answer(403, { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': reset }), NOW),
    ).toBeNull();
  });

  test('a 429 that says nothing of when is a minute; a 403 that says nothing is a repository’s refusal, not the token’s', () => {
    expect(refusalOf(answer(429), NOW)).toEqual({ kind: 'rate_limited', resumesAt: NOW + 60_000 });
    expect(refusalOf(answer(403), NOW)).toBeNull();
    expect(refusalOf(answer(403, { 'retry-after': 'soon' }), NOW)).toBeNull();
  });

  test('a pause is never shorter than a second nor longer than an hour, whatever GitHub writes', () => {
    expect(refusalOf(answer(429, { 'retry-after': '0' }), NOW)).toEqual({
      kind: 'rate_limited',
      resumesAt: NOW + 1000,
    });
    expect(refusalOf(answer(429, { 'retry-after': '-5' }), NOW)).toEqual({
      kind: 'rate_limited',
      resumesAt: NOW + 60_000,
    });
    expect(refusalOf(answer(429, { 'retry-after': '999999999' }), NOW)).toEqual({
      kind: 'rate_limited',
      resumesAt: NOW + 3_600_000,
    });
    // A reset already past: the shortest pause, not a negative one.
    expect(
      refusalOf(
        answer(403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(NOW / 1000 - 100),
        }),
        NOW,
      ),
    ).toEqual({ kind: 'rate_limited', resumesAt: NOW + 1000 });
  });

  test('GitHub failing, or a refusal of something else, is no refusal of the token', () => {
    for (const status of [200, 404, 422, 500, 502, 503]) {
      expect(refusalOf(answer(status, { 'retry-after': '30' }), NOW)).toBeNull();
    }
  });
});

describe('workspaces GitHub told to wait', () => {
  test('a pause holds until its time, for that workspace alone, and a longer one stays', () => {
    const pauses = inProcessPauses();
    expect(pauses.until('a', NOW)).toBeNull();
    pauses.pause('a', NOW + 5000);
    expect(pauses.until('a', NOW)).toBe(NOW + 5000);
    expect(pauses.until('a', NOW + 4999)).toBe(NOW + 5000);
    expect(pauses.until('b', NOW)).toBeNull();
    pauses.pause('a', NOW + 1000);
    expect(pauses.until('a', NOW)).toBe(NOW + 5000);
    expect(pauses.until('a', NOW + 5000)).toBeNull();
    // Over, it is gone: a later call is let through without asking again.
    expect(pauses.until('a', NOW)).toBeNull();
  });
});

describe('a classic token broader than a card needs', () => {
  test('repo and the scopes that write are broad; read-only ones, none and a fine-grained token are not', () => {
    expect(broadScopes('repo')).toBe(true);
    expect(broadScopes('read:org, repo')).toBe(true);
    expect(broadScopes('workflow')).toBe(true);
    expect(broadScopes('delete_repo')).toBe(true);
    expect(broadScopes('admin:org')).toBe(true);
    expect(broadScopes('write:packages')).toBe(true);
    expect(broadScopes('public_repo')).toBe(false);
    expect(broadScopes('repo:status')).toBe(false);
    expect(broadScopes('read:user, user:email')).toBe(false);
    expect(broadScopes('')).toBe(false);
    expect(broadScopes(null)).toBe(false);
  });
});
