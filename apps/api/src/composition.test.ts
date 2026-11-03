import { describe, expect, test } from 'bun:test';
import {
  bundledModules,
  compose,
  composition,
  compositionFor,
  registry,
  type BundledModule,
} from './composition';
import { chatModule } from './features/chat/module';
import { issuesModule } from './features/issues/module';
import { noWorkspaceChannels } from './modules/workspaces/channels-port';

const another: BundledModule = {
  manifest: { id: 'other', requires: [], optional: [], provides: [] },
  workspaceChannels: { ...noWorkspaceChannels },
};

describe('the application as its modules make it', () => {
  test('carries chat and issues, and the registry of the build is sound', () => {
    expect(bundledModules.map((module) => module.manifest.id)).toEqual(['chat', 'issues']);
    expect(registry.resolve(undefined).map((module) => module.id)).toEqual(['chat', 'issues']);
  });

  test('in a build with no module at all, the core stands alone: no hook, nobody for the channels, a purge of its own, its own exports', () => {
    const alone = compose([], []);
    expect(alone.workspaceChannels).toBe(noWorkspaceChannels);
    expect(alone.workspacePurge).toEqual({ before: [], after: [], tables: [] });
    expect(alone.collatedColumns).toEqual([]);
    expect(alone.exportCatalogue.order).toEqual([
      'workspaces',
      'users',
      'workspace_members',
      'workspace_invitations',
      'audit_log',
    ]);
    expect(alone.personalExportCatalogue.order).not.toContain('messages');
    expect(
      alone.exportCatalogue.files({ workspaceId: 'w', kind: 'all', prepared: {} }),
    ).toBeUndefined();
  });

  test('chat not run still keeps its rows whole: its erasure, purge, exports, channel answers and columns apply', () => {
    const notRun = compose([]);
    expect(notRun.modules).toEqual([]);
    expect(notRun.workspaceChannels).toBe(chatModule.workspaceChannels);
    expect(notRun.workspacePurge.before).toHaveLength(2);
    expect(notRun.workspacePurge.tables).toContain('mentions');
    expect(notRun.exportCatalogue.order).toContain('messages');
    expect(notRun.personalExportCatalogue.order).toContain('messages');
    expect(notRun.collatedColumns).toContainEqual(['channels', 'name']);
  });

  test('issues, which has a set of its own, is held only while it runs: nothing of it applies where it does not', () => {
    const issuesNotRun = compose([chatModule]);
    expect(issuesNotRun.workspacePurge.tables).not.toContain('issues');
    expect(issuesNotRun.exportCatalogue.order).not.toContain('issues');
    expect(issuesNotRun.personalExportCatalogue.order).not.toContain('issues');
    expect(compose([]).workspacePurge.tables).not.toContain('issues');

    const run = compose([issuesModule]);
    expect(run.workspacePurge.tables).toContain('issues');
    expect(run.workspacePurge.tables).toContain('mentions');
    expect(run.exportCatalogue.order).toContain('issues');
    expect(run.personalExportCatalogue.order).toContain('issues');
  });

  test('with chat, it has chat’s hooks, answers, purge steps, tables and columns', () => {
    expect(composition.modules).toEqual(bundledModules);
    expect(composition.workspaceChannels).toBe(chatModule.workspaceChannels);
    expect(composition.workspacePurge.before).toHaveLength(2);
    expect(composition.workspacePurge.after).toHaveLength(1);
    expect(composition.workspacePurge.tables).toContain('mentions');
    expect(composition.collatedColumns).toContainEqual(['channels', 'name']);
    expect(composition.exportCatalogue.order).toContain('messages');
    expect(composition.personalExportCatalogue.order).toContain('messages');
  });

  test('refuses two modules that both answer for the channels', () => {
    const second: BundledModule = { ...another, manifest: { ...another.manifest, id: 'second' } };
    expect(() => compose([chatModule, another, second])).toThrow(
      "more than one module answers for a workspace's channels: chat, other, second",
    );
  });

  describe('for the MODULES setting', () => {
    test('unset or blank runs every module; none runs the core alone', () => {
      for (const setting of [undefined, '', '  ']) {
        expect(compositionFor(setting).modules).toEqual(bundledModules);
      }
      expect(compositionFor('none').modules).toEqual([]);
      expect(compositionFor('chat').modules).toEqual([chatModule]);
      expect(compositionFor('issues').modules).toEqual([issuesModule]);
      expect(compositionFor('issues, chat').modules).toEqual(bundledModules);
    });

    test('a module left out has no migration set, its routes and jobs are closed', () => {
      const all = compositionFor(undefined);
      expect(all.migrationSets.map((set) => set.id)).toEqual(['chat', 'issues']);
      expect(all.closed('/api/channels/c1')).toBe(false);
      expect(all.closed('/api/workspaces/w1/issues')).toBe(false);
      expect(all.closed('/api/workspaces/w1/issues/i1')).toBe(false);
      expect(all.closedJob('mail:missed')).toBe(false);

      const chatOnly = compositionFor('chat');
      expect(chatOnly.migrationSets.map((set) => set.id)).toEqual(['chat']);
      expect(chatOnly.closed('/api/workspaces/w1/issues')).toBe(true);
      expect(chatOnly.closed('/api/workspaces/w1/issues/i1')).toBe(true);
      expect(chatOnly.closed('/api/channels/c1')).toBe(false);
      const issuesOnly = compositionFor('issues');
      expect(issuesOnly.migrationSets.map((set) => set.id)).toEqual(['issues']);
      expect(issuesOnly.closed('/api/workspaces/w1/issues')).toBe(false);
      expect(issuesOnly.closed('/api/channels/c1')).toBe(true);
      expect(issuesOnly.closed('/api/workspaces/w1/channels')).toBe(true);

      const alone = compositionFor('none');
      expect(alone.migrationSets).toEqual([]);
      expect(alone.closed('/api/workspaces/w1/issues')).toBe(true);
      expect(alone.closed('/api/channels/c1')).toBe(true);
      expect(alone.closed('/api/workspaces/w1/members')).toBe(false);
      expect(alone.closedJob('mail:missed')).toBe(true);
      // Keeping rows within their retention does not wait for a module to run.
      expect(alone.closedJob('purge:retention')).toBe(false);
      expect(alone.closedJob('sweep:sessions')).toBe(false);
      // The socket's operations of chat are closed with it; the core's are not.
      for (const op of ['SUBSCRIBE', 'UNSUBSCRIBE', 'MESSAGE_SEND', 'TYPING']) {
        expect(alone.closedFrame(op)).toBe(true);
        expect(all.closedFrame(op)).toBe(false);
      }
      for (const op of ['PING', 'ACTIVE']) expect(alone.closedFrame(op)).toBe(false);
      // So are the events it sends; the core's own reach every process.
      for (const event of ['MESSAGE_CREATED', 'CHANNEL_ADDED', 'TYPING', 'PRESENCE']) {
        expect(alone.closedEvent(event)).toBe(true);
        expect(all.closedEvent(event)).toBe(false);
      }
      for (const event of ['WORKSPACE_UPDATED', 'ACCESS_REVOKED', 'SESSION_ENDED', 'PONG', 'ACK']) {
        expect(alone.closedEvent(event)).toBe(false);
      }
    });

    test('a module the build does not carry stops the start, naming it', () => {
      expect(() => compositionFor('chat,calendar')).toThrow(/calendar/);
    });
  });
});
