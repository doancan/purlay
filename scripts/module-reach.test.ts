import { describe, expect, test } from 'bun:test';
import { Linter } from 'eslint';
import { reachPatterns } from './module-reach.mjs';

/** The messages ESLint gives `source` written in a module's file, under the patterns of `reachPatterns` alone. */
const refusals = (source: string, id: string, http: boolean): number => {
  const messages = new Linter().verify(
    source,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { sourceType: 'module' },
        rules: {
          'no-restricted-imports': ['error', { patterns: [...reachPatterns(id, http)] }],
        },
      },
    ],
    { filename: `apps/api/src/features/${id}/${http ? 'http/' : ''}file.ts` },
  );
  return messages.length;
};

const from = (names: string, path: string): string => `import { ${names} } from '${path}';`;

describe('what a module may import of the core', () => {
  test('is refused for the file the module has no line for, whatever it is called', () => {
    for (const path of [
      '../../modules/auth/better-auth',
      '../../modules/inbox/sink',
      '../../platform/outbox',
      '../../platform/config',
      '../../modules/auth/sessions-extra',
    ]) {
      expect(refusals(from('x', path), 'notes', false), path).toBe(1);
    }
  });

  test('is open for what every module is given', () => {
    for (const path of [
      '../../platform/clock',
      '../../platform/tenancy',
      '../../platform/ports/notification-sink',
      '../../platform/module-kit/manifest',
      '../../modules/audit/audit',
    ]) {
      expect(refusals(from('x', path), 'notes', false), path).toBe(0);
    }
  });

  test('is open for two names of the session file, and for no other', () => {
    const sessions = '../../modules/auth/sessions';
    expect(refusals(from('requireLiveSession', sessions), 'notes', false)).toBe(0);
    expect(refusals(from('SessionAuth', sessions), 'notes', false)).toBe(0);
    expect(refusals(from('issueSession', sessions), 'notes', false)).toBe(1);
    expect(refusals(from('revokeAllSessions, requireLiveSession', sessions), 'notes', false)).toBe(
      1,
    );
  });

  test('opens the door’s helpers to the http folder only', () => {
    const session = '../../../ingress/http/session';
    expect(refusals(from('requireSession', session), 'notes', true)).toBe(0);
    expect(refusals(from('requireSession', session), 'notes', false)).toBe(1);
    expect(refusals(from('createApp', '../../../ingress/http/app'), 'notes', true)).toBe(1);
  });

  test('gives a module its own extra lines and no other module’s', () => {
    const mail = '../../platform/mail';
    expect(refusals(from('x', mail), 'chat', false)).toBe(0);
    expect(refusals(from('x', mail), 'notes', false)).toBe(1);
  });
});
