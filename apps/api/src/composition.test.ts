import { describe, expect, test } from 'bun:test';
import {
  bundledModules,
  compose,
  composition,
  compositionFor,
  composeFor,
  moduleReport,
  registry,
  type BundledModule,
} from './composition';
import { chatModule } from './features/chat/module';
import { issuesModule } from './features/issues/module';
import type { AttachmentReader } from './modules/attachments/readable';
import { noPushNotices, type PushNotices } from './modules/push/notices';
import { noWorkspaceChannels } from './modules/workspaces/channels-port';
import { attachmentNotFound, AppError } from './platform/errors';
import { aDatabaseThatMustNotBeTouched, aTransactionThatMustNotBeTouched } from './testing/doubles';

const another: BundledModule = {
  manifest: { id: 'other', requires: [], optional: [], provides: [] },
  workspaceChannels: { ...noWorkspaceChannels },
};

/** A reader that answers for the files it is given and refuses every other, as a module's reader does. */
const readerOf =
  (...files: readonly string[]): AttachmentReader =>
  (_executor, _userId, attachmentId) =>
    files.includes(attachmentId)
      ? Promise.resolve({
          id: attachmentId,
          storageKey: `key/${attachmentId}`,
          thumbnailKey: null,
          fileName: attachmentId,
          kind: 'file',
        })
      : Promise.reject(attachmentNotFound());

/** How a reading ended: the file's id, the refusal's code, or the failure's message. */
const outcomeOf = async (reading: Promise<{ readonly id: string }>): Promise<string> => {
  try {
    return (await reading).id;
  } catch (error: unknown) {
    if (error instanceof AppError) return error.body.code;
    return error instanceof Error ? error.message : 'not an error';
  }
};

const moduleReading = (id: string, reader: AttachmentReader): BundledModule => ({
  manifest: { id, requires: [], optional: [], provides: [] },
  readAttachment: reader,
});

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

  test('issues, whose data is all in a set of its own, is held whether or not it runs, as chat’s own-set tables are', () => {
    for (const modules of [[], [chatModule], [issuesModule]]) {
      const held = compose(modules);
      expect(held.workspacePurge.tables).toContain('issues');
      expect(held.exportCatalogue.order).toContain('issues');
      expect(held.personalExportCatalogue.order).toContain('issues');
    }
    expect(compose([issuesModule]).workspacePurge.tables).toContain('mentions');
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

  describe('who may read an attachment', () => {
    const database = aDatabaseThatMustNotBeTouched();
    const first = moduleReading('first', readerOf('in-first'));
    const second = moduleReading('second', readerOf('in-second'));

    test('is whoever any running module’s reader says may, not the first module’s alone', async () => {
      const both = compose([first, second], [first, second]);
      expect(await outcomeOf(both.readAttachment(database, 'u', 'in-first'))).toBe('in-first');
      expect(await outcomeOf(both.readAttachment(database, 'u', 'in-second'))).toBe('in-second');
    });

    test('is refused as any attachment nobody answers for is, once every reader has said no', async () => {
      const both = compose([first, second], [first, second]);
      expect(await outcomeOf(both.readAttachment(database, 'u', 'nowhere'))).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
    });

    test('does not ask a module that is not run, and keeps a reader’s own failure a failure', async () => {
      const onlyFirst = compose([first], [first, second]);
      expect(await outcomeOf(onlyFirst.readAttachment(database, 'u', 'in-second'))).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
      const broken = moduleReading('broken', () =>
        Promise.reject(new Error('the database is gone')),
      );
      const withBroken = compose([broken, second], [broken, second]);
      expect(await outcomeOf(withBroken.readAttachment(database, 'u', 'in-second'))).toBe(
        'the database is gone',
      );
    });
  });

  describe('what a running module’s reader may say', () => {
    const database = aDatabaseThatMustNotBeTouched();

    test('says no only as `ATTACHMENT_NOT_FOUND`: any other refusal of a reader reaches the caller and no later reader is asked', async () => {
      const busy = moduleReading('busy', () =>
        Promise.reject(new AppError({ code: 'DATABASE_UNAVAILABLE', message: 'busy' })),
      );
      const later = moduleReading('later', readerOf('in-later'));
      const both = compose([busy, later], [busy, later]);
      expect(await outcomeOf(both.readAttachment(database, 'u', 'in-later'))).toBe(
        'DATABASE_UNAVAILABLE',
      );
    });
  });

  describe('the push notices', () => {
    const notices: PushNotices = { of: () => Promise.resolve([]) };
    const noticing: BundledModule = {
      manifest: { id: 'noticing', requires: [], optional: [], provides: [] },
      pushNotices: notices,
    };

    test('are those of a module that runs, and the core’s none for one the build carries but does not run', () => {
      expect(compose([noticing], [noticing]).pushNotices).toBe(notices);
      expect(compose([], [noticing]).pushNotices).toBe(noPushNotices);
    });
  });

  describe('in what order the modules take part', () => {
    const calls: string[] = [];
    const named = (
      id: string,
      requires: readonly string[],
      table: 'issues' | 'mentions' | 'channels',
    ): BundledModule => ({
      manifest: { id, requires, optional: [], provides: [] },
      userErased: (): Promise<void> => {
        calls.push(id);
        return Promise.resolve();
      },
      workspacePurge: { before: [], after: [], tables: [table] },
    });
    // `consumer` sorts before `provider` and stands first in the build's list, but needs it started first.
    const consumer = named('consumer', ['provider'], 'issues');
    const provider = named('provider', [], 'mentions');
    const loner = named('zloner', [], 'channels');
    const carried = [consumer, provider, loner];
    const idsOf = (modules: readonly BundledModule[]): string[] =>
      modules.map((module) => module.manifest.id);

    test('is the order the registry resolved, not the order the build lists them in', () => {
      expect(idsOf(composeFor(carried, undefined).modules)).toEqual([
        'provider',
        'zloner',
        'consumer',
      ]);
    });

    test('keeps what every module holds in that order whichever of them run', async () => {
      for (const setting of [undefined, 'none', 'provider', 'zloner', 'provider,consumer']) {
        calls.length = 0;
        const composed = composeFor(carried, setting);
        expect(composed.workspacePurge.tables).toEqual(['mentions', 'channels', 'issues']);
        await composed.userErased.run(aTransactionThatMustNotBeTouched(), 'u');
        expect(calls).toEqual(['provider', 'zloner', 'consumer']);
      }
    });

    test('has the modules that run act in the resolved order, and only those', () => {
      expect(idsOf(composeFor(carried, 'consumer,zloner,provider').modules)).toEqual([
        'provider',
        'zloner',
        'consumer',
      ]);
      expect(idsOf(composeFor(carried, 'zloner').modules)).toEqual(['zloner']);
      expect(idsOf(composeFor(carried, 'none').modules)).toEqual([]);
    });

    test('stops a build whose module claims a route the core has, or one another module has', () => {
      const claiming = (id: string, routes: string[]): BundledModule => ({
        manifest: { id, requires: [], optional: [], provides: [], routes },
      });
      expect(() => composeFor([claiming('notes', ['/api/me'])], undefined)).toThrow(
        /"notes" owns the route "\/api\/me", which overlaps the core's/,
      );
      expect(() =>
        composeFor([claiming('notes', ['/api/x/**']), claiming('todos', ['/api/x/y'])], undefined),
      ).toThrow(/both own routes that overlap/);
    });

    test('is the same for a build’s own modules whatever the setting', () => {
      expect(compositionFor(undefined).workspacePurge.tables).toEqual(
        compositionFor('issues').workspacePurge.tables,
      );
      expect(compositionFor('none').workspacePurge.tables).toEqual(
        compositionFor('chat').workspacePurge.tables,
      );
    });
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

describe('what the boot says about modules', () => {
  test('names the ones a process runs and the ones the build carries and it does not', () => {
    expect(moduleReport(compositionFor(undefined))).toEqual({
      running: ['chat', 'issues'],
      notRun: [],
    });
    expect(moduleReport(compositionFor('issues'))).toEqual({
      running: ['issues'],
      notRun: ['chat'],
    });
    expect(moduleReport(compositionFor('none'))).toEqual({
      running: [],
      notRun: ['chat', 'issues'],
    });
  });
});
