import { describe, expect, test } from 'bun:test';
import { moduleOf, type RouteName } from './routes';

describe('which module a route belongs to', () => {
  test('the screens of channels, messages and what hangs off them are chat’s', () => {
    for (const name of [
      'channel',
      'questions',
      'inbox',
      'search',
      'saved',
      'drafts',
      'unreads',
    ] as const satisfies readonly RouteName[]) {
      expect(moduleOf(name)).toBe('chat');
    }
  });

  test('sign-in, the workspace, its invitations and its settings are the core’s', () => {
    for (const name of [
      'signIn',
      'signUp',
      'invite',
      'setup',
      'home',
      'workspace',
      'welcome',
      'settingsHome',
      'settings',
    ] as const satisfies readonly RouteName[]) {
      expect(moduleOf(name)).toBeNull();
    }
  });
});
