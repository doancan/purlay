import { describe, expect, test } from 'bun:test';
import {
  bundledModules,
  compose,
  composition,
  compositionFor,
  composeFor,
  moduleReport,
  registry,
  runningModuleIds,
  type BundledModule,
  type Composition,
} from './composition';
import { PRODUCT_MIGRATION_SETS } from '@purlay/db';
import { chatModule } from './features/chat/module';
import { issuesModule } from './features/issues/module';
import type { JobWork } from './modules/jobs/jobs';
import { DEFAULT_WORKER_DEADLINE_MS, type ModuleWorker } from './modules/workers/module-workers';
import type { AttachmentReader } from './modules/attachments/readable';
import { noPushNotices, type PushNotices } from './modules/push/notices';
import { noWorkspaceChannels } from './modules/workspaces/channels-port';
import { attachmentNotFound, AppError } from './platform/errors';
import { CORE_EVENTS, CORE_FRAMES, CORE_JOBS } from './platform/module-kit/core-claims';
import { coreReserve } from './platform/module-budget';
import { aDatabaseThatMustNotBeTouched, aTransactionThatMustNotBeTouched } from './testing/doubles';
import { moduleCells } from './testing/module-cells';
import { concretePath } from './testing/module-smoke';

const bundle: readonly BundledModule[] = bundledModules;

const another: BundledModule = {
  manifest: {
    id: 'other',
    requires: [],
    optional: [],
    provides: [],
    budget: { none: 'a test module' },
  },
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
  manifest: { id, requires: [], optional: [], provides: [], budget: { none: 'a test module' } },
  readAttachment: reader,
});

describe('the application as its modules make it', () => {
  test('carries modules, and the registry of the build is sound', () => {
    const carried = bundledModules.map((module) => module.manifest.id);
    expect(carried).toContain('chat');
    expect(carried).toContain('issues');
    expect(new Set(carried).size).toBe(carried.length);
    expect(registry.resolve(undefined).map((module) => module.id)).toEqual(carried);
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
      manifest: {
        id: 'noticing',
        requires: [],
        optional: [],
        provides: [],
        budget: { none: 'a test module' },
      },
      pushNotices: notices,
    };

    test('are those of a module that runs, and the core’s none for one the build carries but does not run', () => {
      expect(compose([noticing], [noticing]).pushNotices).toBe(notices);
      expect(compose([], [noticing]).pushNotices).toBe(noPushNotices);
    });

    test('are owned, for the failure counter, by the module whose they are, and by the core where none runs', () => {
      expect(compose([noticing], [noticing]).pushOwner).toBe('noticing');
      expect(compose([], [noticing]).pushOwner).toBe('core');
    });
  });

  describe('in what order the modules take part', () => {
    const calls: string[] = [];
    const named = (
      id: string,
      requires: readonly string[],
      table: 'issues' | 'mentions' | 'channels',
    ): BundledModule => ({
      manifest: { id, requires, optional: [], provides: [], budget: { none: 'a test module' } },
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
        await composed.userErased.run(aTransactionThatMustNotBeTouched(), 'u', () => undefined);
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
        manifest: {
          id,
          requires: [],
          optional: [],
          provides: [],
          budget: { none: 'a test module' },
          routes,
        },
      });
      expect(() => composeFor([claiming('notes', ['/api/me'])], undefined)).toThrow(
        /"notes" owns the route "\/api\/me", which overlaps the core's/,
      );
      expect(() =>
        composeFor([claiming('notes', ['/api/x/**']), claiming('todos', ['/api/x/y'])], undefined),
      ).toThrow(/both own routes that overlap/);
    });

    test('is the same for a build’s own modules whatever the setting', () => {
      const cells = moduleCells(bundledModules);
      expect(cells.length).toBeGreaterThan(1);
      const tablesOf = (cell: (typeof cells)[number]): readonly string[] =>
        cell.composition.workspacePurge.tables;
      for (const cell of cells) {
        expect({ cell: cell.label, tables: tablesOf(cell) }).toEqual({
          cell: cell.label,
          tables: cells[0] === undefined ? [] : tablesOf(cells[0]),
        });
      }
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

    test('in every cell of the matrix a module left out has no migration set and its routes, jobs, frames and events are closed', () => {
      const cells = moduleCells(bundledModules);
      expect(cells.length).toBeGreaterThan(bundledModules.length);
      const withSets = new Set<string>(PRODUCT_MIGRATION_SETS.map((set) => set.id));
      for (const cell of cells) {
        const seen = cell.composition;
        expect(seen.migrationSets.map((set) => set.id)).toEqual(
          cell.ids.filter((id) => withSets.has(id)),
        );
        for (const { manifest } of bundle) {
          const closed = !cell.ids.includes(manifest.id);
          const said = (what: string): string => `${cell.label}: ${manifest.id} ${what}`;
          for (const route of manifest.routes ?? []) {
            expect({ [said(route)]: seen.closed(concretePath(route)) }).toEqual({
              [said(route)]: closed,
            });
          }
          for (const job of manifest.jobs ?? []) {
            expect({ [said(job)]: seen.closedJob(job) }).toEqual({ [said(job)]: closed });
          }
          for (const op of manifest.frames ?? []) {
            expect({ [said(op)]: seen.closedFrame(op) }).toEqual({ [said(op)]: closed });
          }
          for (const event of manifest.events ?? []) {
            expect({ [said(event)]: seen.closedEvent(event) }).toEqual({ [said(event)]: closed });
          }
        }
        // What the core claims is open in every cell, whatever runs.
        for (const op of CORE_FRAMES) expect(seen.closedFrame(op)).toBe(false);
        for (const event of CORE_EVENTS) expect(seen.closedEvent(event)).toBe(false);
        for (const job of CORE_JOBS) expect(seen.closedJob(job)).toBe(false);
      }
    });

    test('chat’s and issues’ own paths stay as the manifests give them, and the core’s stay open', () => {
      const all = compositionFor(undefined);
      expect(all.closed('/api/channels/c1')).toBe(false);
      expect(all.closed('/api/workspaces/w1/issues/i1')).toBe(false);
      expect(all.closedJob('mail:missed')).toBe(false);
      const chatOnly = compositionFor('chat');
      expect(chatOnly.closed('/api/workspaces/w1/issues')).toBe(true);
      expect(chatOnly.closed('/api/channels/c1')).toBe(false);
      const issuesOnly = compositionFor('issues');
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
    const carried = bundledModules.map((module) => module.manifest.id);
    for (const cell of moduleCells(bundledModules)) {
      expect({ cell: cell.label, ...moduleReport(cell.composition) }).toEqual({
        cell: cell.label,
        running: cell.ids,
        notRun: carried.filter((id) => !cell.ids.includes(id)),
      });
    }
  });
});

describe('the ids a process tells a client it runs (D-273)', () => {
  test('are the ones it runs, as the contract’s ModuleId spells them', () => {
    expect(runningModuleIds(compositionFor(undefined))).toEqual(['chat', 'issues']);
    expect(runningModuleIds(compositionFor('issues'))).toEqual(['issues']);
    expect(runningModuleIds(compositionFor('none'))).toEqual([]);
  });

  test('stop a build that runs a module the contract has no id for, rather than tell a client an id it cannot decode', () => {
    const unknown: BundledModule = { manifest: { ...moduleReading('notes', readerOf()).manifest } };
    const running = compose([unknown], [...bundledModules, unknown]);
    expect(() => runningModuleIds(running)).toThrow(/notes.*ModuleId/);
  });
});

describe('the workers of the modules a process runs', () => {
  const carried = [chatModule, issuesModule];
  const namesOf = (running: readonly BundledModule[]): string[] =>
    compose(running, carried).workers.map(({ module, name }) => `${module}/${name}`);

  test('are chat’s two delivery loops where chat runs, and nothing where it is carried and off or not carried at all', () => {
    expect(namesOf([chatModule])).toEqual(['chat/deliver:scheduled', 'chat/deliver:reminders']);
    expect(namesOf([chatModule, issuesModule])).toEqual([
      'chat/deliver:scheduled',
      'chat/deliver:reminders',
    ]);
    expect(namesOf([issuesModule])).toEqual([]);
    expect(namesOf([])).toEqual([]);
    expect(compose([], []).workers).toEqual([]);
  });

  test('carry the deadline of their module’s manifest: the default for chat, none for a module that declared none', () => {
    expect(compose([chatModule], carried).workers.map(({ deadlineMs }) => deadlineMs)).toEqual([
      DEFAULT_WORKER_DEADLINE_MS,
      DEFAULT_WORKER_DEADLINE_MS,
    ]);
    const patient: BundledModule = {
      ...another,
      manifest: { ...another.manifest, workerDeadline: { none: 'it waits on a person' } },
      workers: [
        {
          name: 'wait:person',
          intervalMs: 5_000,
          work: async (): Promise<void> => {
            await Promise.resolve();
          },
        },
      ],
    };
    expect(compose([patient], [patient]).workers.map(({ deadlineMs }) => deadlineMs)).toEqual([
      undefined,
    ]);
    const quick: BundledModule = {
      ...patient,
      manifest: { ...another.manifest, workerDeadline: { ms: 2_000 } },
    };
    expect(compose([quick], [quick]).workers.map(({ deadlineMs }) => deadlineMs)).toEqual([2_000]);
  });

  test('stop the build when two share a name, a name is not one, or an interval is not a whole number of milliseconds a loop could have', () => {
    const work = async (): Promise<void> => {
      await Promise.resolve();
    };
    const build = (...workers: ModuleWorker[]): Composition => {
      const module: BundledModule = { manifest: another.manifest, workers };
      return compose([module], [module]);
    };
    const named = (name: string, intervalMs = 5_000): ModuleWorker => ({ name, intervalMs, work });
    expect(() => build(named('a:b'), named('a:b'))).toThrow('"other" has two workers called "a:b"');
    expect(() => build(named('Deliver now'))).toThrow('"other" has a worker called "Deliver now"');
    for (const intervalMs of [0, 999, 3_600_001, 1.5, Number.NaN]) {
      expect(() => build(named('a:b', intervalMs))).toThrow(
        `"other" has the worker "a:b" run every ${String(intervalMs)} ms`,
      );
    }
    expect(() => build(named('a:b', 3_600_000), named('c', 1_000))).not.toThrow();
  });
});

describe('the share of the database each module declares (D-250 rule 7, D-266)', () => {
  test('issues has a third of the pool and chat what the modules may take together less one', () => {
    const { budget } = issuesModule.manifest;
    expect('poolShare' in budget && budget.poolShare(30)).toEqual({
      maxConcurrent: 10,
      queueTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
    });
    const chat = chatModule.manifest.budget;
    expect('poolShare' in chat && chat.poolShare(10)).toEqual({
      maxConcurrent: 7,
      queueTimeoutMs: 3_000,
      statementTimeoutMs: 30_000,
    });
  });

  test('no module can take every connection the modules may share, at any pool a deployment may have', () => {
    for (const poolMax of [2, 3, 6, 10, 30, 100]) {
      const together = Math.max(1, poolMax - coreReserve(poolMax));
      for (const { manifest } of bundledModules) {
        if (!('poolShare' in manifest.budget)) continue;
        const { maxConcurrent } = manifest.budget.poolShare(poolMax);
        // One left for the next module, in every pool that has a second connection to give.
        expect(maxConcurrent).toBeLessThan(Math.max(2, together));
      }
    }
  });

  test('a build with a module that says nothing of it does not start', () => {
    expect(() =>
      composeFor(
        // @ts-expect-error a module without a `budget` is not a BundledModule
        [{ manifest: { id: 'other', requires: [], optional: [], provides: [] } }],
        undefined,
      ),
    ).toThrow(/"other" does not say what it may take of the database/);
  });
});

describe('the work of the jobs a module names', () => {
  const work: JobWork = () => Promise.resolve({ done: 1 });
  const withJobs = (
    manifest: { jobs?: string[]; retention?: string[] },
    jobWork?: Record<string, JobWork>,
  ): BundledModule => ({
    manifest: { ...another.manifest, ...manifest },
    ...(jobWork === undefined ? {} : { jobWork }),
  });

  test('a job the manifest names with no work, and work it does not name, each stop the build', () => {
    expect(() => compose([], [withJobs({ jobs: ['other:send'] })])).toThrow(
      '"other" names the jobs other:send in its manifest and supplies no work for them',
    );
    expect(() => compose([], [withJobs({ retention: ['purge:other'] }, {})])).toThrow(
      '"other" names the jobs purge:other in its manifest and supplies no work for them',
    );
    expect(() => compose([], [withJobs({}, { 'purge:other': work })])).toThrow(
      '"other" supplies work for purge:other, which its manifest does not name under jobs or retention',
    );
  });

  test('retention work is the process’s whichever modules run, and a job’s waits for its module', () => {
    const module = withJobs(
      { jobs: ['other:send'], retention: ['purge:other'] },
      { 'other:send': work, 'purge:other': work },
    );
    const off = compose([], [module]);
    expect(Object.keys(off.jobWork).sort()).toEqual(['other:send', 'purge:other']);
    expect(off.closedJob('other:send')).toBe(true);
    expect(off.closedJob('purge:other')).toBe(false);
    expect(compose([module], [module]).closedJob('other:send')).toBe(false);
  });

  test('chat’s purge and sweeps are retention, its mail a job, and none is closed but the mail with chat off', () => {
    const alone = compositionFor('none');
    expect(Object.keys(alone.jobWork).sort()).toEqual([
      'mail:missed',
      'purge:retention',
      'sweep:github-deliveries',
      'sweep:link-previews',
    ]);
    expect(chatModule.manifest.retention).toEqual([
      'purge:retention',
      'sweep:link-previews',
      'sweep:github-deliveries',
    ]);
    expect(
      ['purge:retention', 'sweep:link-previews', 'sweep:github-deliveries'].map(alone.closedJob),
    ).toEqual([false, false, false]);
    expect(alone.closedJob('mail:missed')).toBe(true);
  });
});

describe('what a process that does not run a module has of it (permissions and the trail)', () => {
  const deleteAny = 'issues.delete-any';

  test('the permissions of a module are held while it runs and by nobody once it does not, the owner included', () => {
    const running = compositionFor(undefined).permissions;
    expect(running.holds('member', deleteAny)).toBe(false);
    expect(running.holds('admin', deleteAny)).toBe(true);
    expect(running.holds('owner', deleteAny)).toBe(true);
    const off = compositionFor('chat').permissions;
    expect(off.holds('owner', deleteAny)).toBe(false);
    expect(off.holds('owner', 'audit.read')).toBe(true);
  });

  test('every module of the build is judged for the trail, run or not, so its rows are not lost by leaving it out', () => {
    expect(compositionFor('none').auditAccess.unreadable('admin')).toEqual([]);
    expect(compositionFor('none').auditAccess.mayRead('admin')).toBe(true);
    expect(compositionFor('none').auditAccess.mayRead('member')).toBe(false);
  });

  test('a module that declares its own read permission has its rows hidden once it is not run', () => {
    const guarded: BundledModule = {
      manifest: {
        ...another.manifest,
        permissions: [{ name: 'other.audit', minimumRole: 'owner' }],
        auditActions: [{ read: 'other.audit', actions: ['other.done'] }],
      },
    };
    expect(compose([guarded], [guarded]).auditAccess.unreadable('admin')).toEqual(['other.done']);
    expect(compose([guarded], [guarded]).auditAccess.unreadable('owner')).toEqual([]);
    expect(compose([], [guarded]).auditAccess.unreadable('owner')).toEqual(['other.done']);
  });
});

describe('what a process that does not run a module offers of it', () => {
  test('its notification kinds and its search sources are those of the modules that run', () => {
    expect(compositionFor(undefined).notificationKinds.map((kind) => kind.type)).toContain(
      'mention',
    );
    expect(compositionFor(undefined).searchSources).toEqual(['messages', 'issues']);
    expect(compositionFor('issues').notificationKinds).toEqual([]);
    expect(compositionFor('issues').searchSources).toEqual(['issues']);
    expect(compositionFor('none').searchSources).toEqual([]);
  });
});
