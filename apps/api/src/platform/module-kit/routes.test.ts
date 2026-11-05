import { describe, expect, test } from 'bun:test';
import { ownsPath, templatesOverlap } from './routes';

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

describe('which templates claim a path in common', () => {
  test('the same template, a name against a literal, and a subtree over what is below it', () => {
    expect(templatesOverlap('/api/a/b', '/api/a/b')).toBe(true);
    expect(templatesOverlap('/api/a/:id', '/api/a/b')).toBe(true);
    expect(templatesOverlap('/api/a/**', '/api/a/b')).toBe(true);
    expect(templatesOverlap('/api/a/**', '/api/a/b/c/:d')).toBe(true);
    expect(templatesOverlap('/api/a/**', '/api/a/**')).toBe(true);
    expect(templatesOverlap('/api/a/:x/c', '/api/a/b/:y')).toBe(true);
  });

  test('reads a trailing star, as the core spells its catch-all, as the rest of the path', () => {
    expect(templatesOverlap('/auth/foo', '/auth/*')).toBe(true);
    expect(templatesOverlap('/auth/*', '/auth/foo/bar')).toBe(true);
    expect(templatesOverlap('/auth/*', '/auth/**')).toBe(true);
    expect(templatesOverlap('/auth/*', '/auth')).toBe(false);
    expect(templatesOverlap('/auth/*', '/other/foo')).toBe(false);
  });

  test('is not two templates that no path matches both of', () => {
    expect(templatesOverlap('/api/a/b', '/api/a/c')).toBe(false);
    expect(templatesOverlap('/api/a/b', '/api/a/b/c')).toBe(false);
    // A subtree is what is below its prefix, not the prefix.
    expect(templatesOverlap('/api/a/**', '/api/a')).toBe(false);
    expect(templatesOverlap('/api/a/**', '/api/b/c')).toBe(false);
    expect(templatesOverlap('/api/w/:id/x', '/api/w/:id/y')).toBe(false);
  });
});
