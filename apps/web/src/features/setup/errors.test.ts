import { describe, expect, test } from 'bun:test';
import { SetupFailure } from './client';
import { failureWords, MAIL_STAGES, REASONS } from './errors';

describe('where a mail try stopped', () => {
  test('a refused or unanswered address stopped at the connection, not at the address', () => {
    expect(MAIL_STAGES[REASONS.unreachable.stoppedAt ?? 0]).toBe('setup.email.stage.connected');
  });

  test('the login and the message are reached only after the connection', () => {
    expect(REASONS['auth-failed'].stoppedAt).toBe(2);
    expect(REASONS['sender-refused'].stoppedAt).toBe(3);
  });
});

describe('the sentence for a call that failed', () => {
  const failure = (
    code: ConstructorParameters<typeof SetupFailure>[1],
    retryAfter: number | null = null,
  ): SetupFailure => new SetupFailure(500, code, 'x', retryAfter);

  test('says the server could not be reached for a network failure', () => {
    expect(failureWords(failure('NETWORK'))).toEqual({
      kind: 'plain',
      key: 'setup.failed.network',
    });
  });

  test('says the wait in whole minutes, rounded up, and at least one', () => {
    expect(failureWords(failure('RATE_LIMITED', 61))).toEqual({ kind: 'rate', minutes: 2 });
    expect(failureWords(failure('RATE_LIMITED', 5))).toEqual({ kind: 'rate', minutes: 1 });
  });

  test('assumes a minute when the server did not say how long', () => {
    expect(failureWords(failure('RATE_LIMITED'))).toEqual({ kind: 'rate', minutes: 1 });
  });

  test('says an earlier step is unfinished for a refused step', () => {
    expect(failureWords(failure('SETUP_STEP_REFUSED'))).toEqual({
      kind: 'plain',
      key: 'setup.failed.order',
    });
  });

  test('falls to the generic sentence for any other code', () => {
    expect(failureWords(failure('INTERNAL'))).toEqual({
      kind: 'plain',
      key: 'setup.failed.generic',
    });
  });
});
