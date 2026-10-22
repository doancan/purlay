import { describe, expect, test } from 'bun:test';
import { PROBE_REASONS, SETUP_STEPS } from './setup';

describe('the reasons a try fails (D-179 §4.4)', () => {
  test('are a closed set, each once, and none a probe cannot produce', () => {
    expect(PROBE_REASONS).toEqual([
      'secret-rejected',
      'client-unknown',
      'unreachable',
      'tls-failed',
      'auth-failed',
      'sender-refused',
      'recipient-refused',
      'message-refused',
      'unexpected-reply',
    ]);
    // A GitHub callback address cannot be tried without a browser (Ruling R47).
    expect(PROBE_REASONS).not.toContain('callback-mismatch');
  });
});

describe('the setup’s steps (D-179 §4)', () => {
  test('are the wizard’s, in its order, each once', () => {
    expect(SETUP_STEPS).toEqual([
      'claim',
      'admin',
      'address',
      'policy',
      'github',
      'email',
      'workspace',
      'invite',
      'finish',
    ]);
  });
});
