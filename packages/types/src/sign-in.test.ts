import { describe, expect, test } from 'bun:test';
import { SIGN_IN_PATH, SignInFailure, signInFailureHref, signInFailureIn } from './sign-in';

const EVERY_FAILURE = SignInFailure.anyOf.map((literal) => literal.const);

describe('the address a failed sign-in comes back to', () => {
  test('there is a reason for every case the callback distinguishes', () => {
    expect(EVERY_FAILURE).toEqual([
      'cancelled',
      'expired',
      'email-required',
      'email-taken',
      'github-unavailable',
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
