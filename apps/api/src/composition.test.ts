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
import { noWorkspaceChannels } from './modules/workspaces/channels-port';

const another: BundledModule = {
  manifest: { id: 'other', requires: [], optional: [], provides: [] },
  workspaceChannels: { ...noWorkspaceChannels },
};

describe('the application as its modules make it', () => {
  test('carries chat, and the registry of the build is sound', () => {
    expect(bundledModules.map((module) => module.manifest.id)).toEqual(['chat']);
    expect(registry.resolve(undefined).map((module) => module.id)).toEqual(['chat']);
  });

  test('with no module, the core stands alone: no hook, nobody for the channels, a purge of its own, its own exports', () => {
    const alone = compose([]);
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
      expect(compositionFor('chat').modules).toEqual(bundledModules);
    });

    test('a module left out has no migration set, its routes and jobs are closed', () => {
      const all = compositionFor(undefined);
      expect(all.migrationSets.map((set) => set.id)).toEqual(['chat']);
      expect(all.closed('/api/channels/c1')).toBe(false);
      expect(all.closedJob('purge:retention')).toBe(false);

      const alone = compositionFor('none');
      expect(alone.migrationSets).toEqual([]);
      expect(alone.closed('/api/channels/c1')).toBe(true);
      expect(alone.closed('/api/workspaces/w1/members')).toBe(false);
      expect(alone.closedJob('purge:retention')).toBe(true);
      expect(alone.closedJob('mail:missed')).toBe(true);
      expect(alone.closedJob('sweep:sessions')).toBe(false);
    });

    test('a module the build does not carry stops the start, naming it', () => {
      expect(() => compositionFor('chat,calendar')).toThrow(/calendar/);
    });
  });
});
