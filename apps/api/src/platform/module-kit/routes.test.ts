import { describe, expect, test } from 'bun:test';
import { ownsPath } from './routes';

describe('which paths a module owns', () => {
  const owns = ownsPath([
    '/api/messages/**',
    '/api/channels/:channelId/messages',
    '/api/notifications',
    '/api/workspaces/:workspaceId/channels',
  ]);

  test('a literal path, and a path with a segment that is a name', () => {
    expect(owns('/api/notifications')).toBe(true);
    expect(owns('/api/channels/abc/messages')).toBe(true);
    expect(owns('/api/workspaces/w1/channels')).toBe(true);
  });

  test('a subtree is every path below its prefix, and not the prefix itself', () => {
    expect(owns('/api/messages/m1')).toBe(true);
    expect(owns('/api/messages/m1/thread/read')).toBe(true);
    expect(owns('/api/messages')).toBe(false);
  });

  test('is not a path that only starts like one, or is shorter or longer than a template without a subtree', () => {
    expect(owns('/api/channels/abc')).toBe(false);
    expect(owns('/api/channels/abc/messages/extra')).toBe(false);
    expect(owns('/api/notifications/read')).toBe(false);
    expect(owns('/api/workspaces/w1')).toBe(false);
    expect(owns('/api/workspaces/w1/channelsx')).toBe(false);
    expect(owns('/api/me')).toBe(false);
  });

  test('ignores a trailing slash and an empty segment, and an empty list owns nothing', () => {
    expect(owns('/api/notifications/')).toBe(true);
    expect(ownsPath([])('/api/notifications')).toBe(false);
  });
});
