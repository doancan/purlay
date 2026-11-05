import { describe, expect, test } from 'bun:test';
import { bundledModules } from '../../composition';
import { CORE_CLAIMS } from './core-claims';
import { CORE_OWNER, NO_OWNER, ownersOf } from './ownership';

const owners = ownersOf(
  bundledModules.map((module) => module.manifest),
  CORE_CLAIMS,
);

describe('who owns a route, a job or a socket operation', () => {
  test('a route is the core’s, a module’s by its manifest, or nobody’s', () => {
    expect(owners.ofRoute('/health')).toBe(CORE_OWNER);
    expect(owners.ofRoute('/auth/*')).toBe(CORE_OWNER);
    expect(owners.ofRoute('/api/channels/:channelId')).toBe('chat');
    expect(owners.ofRoute('/api/workspaces/:workspaceId/issues')).toBe('issues');
    expect(owners.ofRoute('/api/workspaces/:workspaceId/issues/:issueId')).toBe('issues');
    // The client's catch-all, a request the edge turned away and one nothing matched are no module's.
    for (const route of ['/*', '(edge)', '(unmatched)', '/api/no-such']) {
      expect(owners.ofRoute(route)).toBe(NO_OWNER);
    }
  });

  test('a job is a module’s when its manifest lists it, the core’s when the core does, or nobody’s', () => {
    expect(owners.ofJob('mail:missed')).toBe('chat');
    // A purge or a sweep a module keeps (`retention`) is the module's, though it runs whether the module does or not.
    for (const job of ['purge:retention', 'sweep:link-previews', 'sweep:github-deliveries']) {
      expect(owners.ofJob(job)).toBe('chat');
    }
    expect(owners.ofJob('sweep:sessions')).toBe(CORE_OWNER);
    expect(owners.ofJob('no:such-job')).toBe(NO_OWNER);
  });

  test('a socket operation is the core’s, a module’s by its manifest, or nobody’s', () => {
    expect(owners.ofFrame('PING')).toBe(CORE_OWNER);
    for (const op of ['SUBSCRIBE', 'MESSAGE_SEND', 'TYPING'])
      expect(owners.ofFrame(op)).toBe('chat');
    // Words that are no operation, as a frame that never named one would be: nobody's, never an unbounded label.
    for (const op of ['', 'NO_SUCH_OP', 'ping']) expect(owners.ofFrame(op)).toBe(NO_OWNER);
  });
});
