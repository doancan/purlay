import { describe, expect, test } from 'bun:test';
import {
  ConnectGitHubOutcome,
  SIGN_IN_PATH,
  SignInFailure,
  connectGitHubHref,
  connectGitHubOutcomeIn,
  signInFailureHref,
  signInFailureIn,
} from './sign-in';

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

describe('the address a connect of GitHub comes back to (D-172)', () => {
  const EVERY_OUTCOME = ConnectGitHubOutcome.anyOf.map((literal) => literal.const);

  for (const outcome of EVERY_OUTCOME) {
    test(`\`${outcome}\` is written on the account page's address and read back as itself`, () => {
      const address = new URL(connectGitHubHref('acme-eng', outcome), 'https://purlay.test');
      expect(address.origin).toBe('https://purlay.test');
      expect(address.pathname).toBe('/w/acme-eng/settings/account');
      expect([...address.searchParams.keys()]).toEqual(['github']);
      expect(connectGitHubOutcomeIn(address.search)).toBe(outcome);
    });
  }

  test('an address with no outcome reads as none, and one outside the set as a failure', () => {
    expect(connectGitHubOutcomeIn('')).toBeNull();
    expect(connectGitHubOutcomeIn('?github=<script>')).toBe('failed');
  });
});
