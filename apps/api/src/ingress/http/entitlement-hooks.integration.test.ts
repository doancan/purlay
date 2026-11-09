/**
 * The hooks that bypass the routes ask the workspace's grant too (D-289 §9, red-team F10): a module's reader of files, its
 * start for a new workspace and its pushes act without a request of the module, so the guard of a route never sees them.
 * Retention is a hook as well, and is the one that must NOT ask: a workspace that lost a module keeps the data's lifecycle.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { messageId } from '@purlay/types';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { compose, type BundledModule, type Composition } from '../../composition';
import { chatModule } from '../../features/chat/module';
import { fixedClock } from '../../platform/clock';
import { attachmentNotFound } from '../../platform/errors';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';
import type { PushNotices } from '../../modules/push/notices';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

/** What the module's start was asked, in order. */
const asked: string[] = [];

const retentionWork = (): Promise<{ deleted: number }> => Promise.resolve({ deleted: 0 });
const pushNotices: PushNotices = {
  canDeliver: () => Promise.resolve(true),
  of: (_executor, _messageId, userIds) =>
    Promise.resolve(
      userIds.map((userId) => ({
        userId,
        type: 'mention',
        channelId: crypto.randomUUID(),
        workspaceId: workspaceOfNotice.id,
        channelName: null,
        groupNames: null,
        authorName: 'ada',
        rootSenderId: null,
        threadId: null,
      })),
    ),
};
const workspaceOfNotice = { id: '' };

/** A stand-in for `issues` (the one id a build may carry that a workspace is granted), which fills every hook the routes do not guard. */
const things: BundledModule = {
  manifest: {
    id: 'issues',
    requires: [],
    optional: [],
    degrades: {},
    provides: [],
    budget: { none: 'a test module' },
    retention: ['sweep:things'],
  },
  readAttachment: (_executor, _userId, attachmentId) =>
    Promise.resolve({
      id: attachmentId,
      storageKey: `key/${attachmentId}`,
      thumbnailKey: null,
      fileName: 'plan.txt',
      kind: 'file',
    }),
  workspaceCreated: (_transaction, _clock, context) => {
    asked.push(`created:${context.workspaceId}`);
    return Promise.resolve();
  },
  pushNotices,
  jobWork: { 'sweep:things': { run: retentionWork } as never },
};

const carried: readonly BundledModule[] = [chatModule, things];
const OPEN = compose([chatModule, things], carried, 'open');
const MANAGED = compose([chatModule, things], carried, 'managed');
/** Without chat, whose notices are the first a composition takes: the stand-in's are what is asked. */
const ONLY_THINGS = compose([things], carried, 'open');

const createWorkspace = async (
  db: Executor,
  modules: Composition,
  who: SignedInUser,
): Promise<string | undefined> => {
  const app = createApp(testDependencies({ database: db, clock, composition: modules }));
  const slug = aUniqueSlug('hooks');
  const response = await app.handle(
    new Request(`${ORIGIN}/api/workspaces`, {
      method: 'POST',
      headers: { cookie: who.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: slug, slug }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const grant = async (db: Executor, workspaceId: string, state: 'on' | 'off'): Promise<void> => {
  await db
    .insertInto('workspace_modules')
    .values({
      workspace_id: workspaceId,
      module: 'issues',
      state,
      valid_until: null,
      source: 'operator',
      changed_at: NOW,
    })
    .execute();
};

const anAttachmentIn = async (db: Executor, workspaceId: string, owner: string): Promise<string> =>
  (
    await db
      .insertInto('attachments')
      .values({
        id: messageId(NOW),
        workspace_id: workspaceId,
        uploader_id: owner,
        storage_key: `k/${crypto.randomUUID()}`,
        file_name: 'plan.txt',
        mime_type: 'text/plain',
        size_bytes: 1,
        // Claimed, so the core's own reader of unsent uploads has no say and the module's is what is asked.
        claimed_at: NOW,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

describe('integration: a module’s start for a new workspace is for the workspaces granted it', () => {
  test('a managed server whose new workspace has no grant does not run it; an open server does', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'hooks-created');
      asked.length = 0;
      const managed = await createWorkspace(db, MANAGED, owner);
      expect(asked).toEqual([]);
      const open = await createWorkspace(db, OPEN, owner);
      expect(asked).toEqual([`created:${open ?? ''}`]);
      expect(managed).not.toBe(open);
    });
  });
});

describe('integration: a module’s reader of files answers for the workspaces granted it', () => {
  const outcomeOf = async (read: Promise<unknown>): Promise<unknown> =>
    await read.then(
      () => 'readable',
      (error: unknown) => error,
    );

  test('a file the module says is readable is not, while its workspace is not granted the module', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'hooks-file');
      const workspaceId = (await createWorkspace(db, OPEN, owner)) ?? '';
      const file = await anAttachmentIn(db, workspaceId, owner.userId);

      // Managed and no row: not granted. Granted `on`: readable. Withdrawn: refused as a file nobody answers for.
      expect(await outcomeOf(MANAGED.readAttachment(db, owner.userId, file))).toEqual(
        attachmentNotFound(),
      );
      await grant(db, workspaceId, 'on');
      expect(await outcomeOf(MANAGED.readAttachment(db, owner.userId, file))).toBe('readable');
      await db
        .updateTable('workspace_modules')
        .set({ state: 'off' })
        .where('workspace_id', '=', workspaceId)
        .execute();
      expect(await outcomeOf(MANAGED.readAttachment(db, owner.userId, file))).toEqual(
        attachmentNotFound(),
      );
      // An open server honours a withdrawal in the table in the same way.
      expect(await outcomeOf(OPEN.readAttachment(db, owner.userId, file))).toEqual(
        attachmentNotFound(),
      );
    });
  });

  test('a file of a workspace that is granted it is readable on an open server with no row at all', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'hooks-file-open');
      const workspaceId = (await createWorkspace(db, OPEN, owner)) ?? '';
      const file = await anAttachmentIn(db, workspaceId, owner.userId);
      expect(await outcomeOf(OPEN.readAttachment(db, owner.userId, file))).toBe('readable');
    });
  });
});

describe('integration: a module’s push notices are for the workspaces granted it', () => {
  test('the notices of a workspace that lost the module are dropped and the others kept', async () => {
    await withRollback(async (db) => {
      const owner = await aSignedInUser(db, clock, 'hooks-push');
      const granted = (await createWorkspace(db, OPEN, owner)) ?? '';
      const lost = (await createWorkspace(db, OPEN, owner)) ?? '';
      await grant(db, lost, 'off');
      workspaceOfNotice.id = granted;
      expect(
        (await ONLY_THINGS.pushNotices.of(db, crypto.randomUUID(), [owner.userId])).map(
          (notice) => notice.workspaceId,
        ),
      ).toEqual([granted]);
      expect(await ONLY_THINGS.pushNotices.canDeliver(db, crypto.randomUUID(), owner.userId)).toBe(
        true,
      );
      const unavailable = compose(
        [
          {
            ...things,
            pushNotices: {
              ...pushNotices,
              canDeliver: (): Promise<boolean> => Promise.resolve(false),
            },
          },
        ],
        carried,
        'open',
      );
      expect(await unavailable.pushNotices.canDeliver(db, crypto.randomUUID(), owner.userId)).toBe(
        false,
      );
      workspaceOfNotice.id = lost;
      expect(await ONLY_THINGS.pushNotices.of(db, crypto.randomUUID(), [owner.userId])).toEqual([]);
      expect(await ONLY_THINGS.pushNotices.canDeliver(db, crypto.randomUUID(), owner.userId)).toBe(
        false,
      );
    });
  });
});

describe('integration: retention does not ask the grant', () => {
  test('the work of a module’s retention job is the module’s own, whatever any workspace is granted', () => {
    expect(MANAGED.jobWork['sweep:things']).toBe(things.jobWork?.['sweep:things']);
    expect(OPEN.jobWork['sweep:things']).toBe(things.jobWork?.['sweep:things']);
  });
});
