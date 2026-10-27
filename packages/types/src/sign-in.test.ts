import { describe, expect, test } from 'bun:test';
import {
  AUTH_BASE_PATH,
  OIDC_CALLBACK,
  OIDC_START_PATH,
  SIGN_IN_CALLBACK,
  SIGN_IN_PATH,
  SignInFailure,
  signInFailureHref,
  signInFailureIn,
} from './sign-in';

const EVERY_FAILURE = SignInFailure.anyOf.map((literal) => literal.const);

describe('where GitHub sends the browser back (D-179, R13)', () => {
  test('is the sign-in library’s own callback for GitHub, under its base path', () => {
    expect(AUTH_BASE_PATH).toBe('/auth');
    expect(SIGN_IN_CALLBACK).toBe('/auth/callback/github');
  });

  test('and where the single sign-on provider does (D-200): a start of ours, the library’s callback', () => {
    expect(OIDC_START_PATH).toBe('/auth/oidc');
    expect(OIDC_CALLBACK).toBe('/auth/callback/oidc');
  });
});

describe('the address a failed sign-in comes back to', () => {
  test('there is a reason for every case the callback distinguishes', () => {
    expect(EVERY_FAILURE).toEqual([
      'cancelled',
      'expired',
      'email-required',
      'email-taken',
      'signup-closed',
      'github-unavailable',
      'oidc-unavailable',
      'email-unverified',
      'busy',
      'failed',
    ]);
  });

  for (const failure of EVERY_FAILURE) {
    test(`\`${failure}\` is written on the sign-in screen's address and read back as itself`, () => {
      const address = new URL(signInFailureHref(failure), 'https://purlay.test');
      expect(address.pathname).toBe(SIGN_IN_PATH);
      // The reason and nothing else: one parameter.
      expect([...address.searchParams.keys()]).toEqual(['error']);
      expect(signInFailureIn(address.search)).toBe(failure);
    });
  }

  test('an address with no reason reads as none', () => {
    expect(signInFailureIn('')).toBeNull();
    expect(signInFailureIn('?reason=ended')).toBeNull();
  });

  test('a reason outside the set still reads as a failure, never as nothing', () => {
    expect(signInFailureIn('?error=1')).toBe('failed');
    expect(signInFailureIn('?error=<script>')).toBe('failed');
    expect(signInFailureIn('?error=')).toBe('failed');
  });
});
