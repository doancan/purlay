/** Actual guest edits/conversion commit before a waiting content writer chooses its current authority. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { updateGuestAccess } from '../../../modules/workspaces/guest-access';
import { convertGuest } from '../../../modules/workspaces/guest-conversion';
import { addBookmark, channelBookmarks } from '../bookmarks/bookmarks';
import { changeIncident, channelIncident, declareIncident } from '../incidents/incidents';
import { requireChannelById } from './guard';
import { chatWorkspaceChannels } from './workspace-channels';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const pidOf = async (db: Transaction): Promise<number> =>
  (await db.selectNoFrom(sql<number>`pg_backend_pid()`.as('pid')).executeTakeFirstOrThrow()).pid;

const blockedBy = async (
  pid: number,
  blocker: number,
  work: Promise<unknown>,
): Promise<boolean> => {
  const progress = { settled: false };
  void work.then(
    () => {
      progress.settled = true;
    },
    () => {
      progress.settled = true;
    },
  );
  const deadline = Date.now() + 3_000;
  while (!progress.settled && Date.now() < deadline) {
    const row = await cloned.db
      .selectNoFrom(sql<number[]>`pg_blocking_pids(${pid})`.as('pids'))
      .executeTakeFirstOrThrow();
    if (row.pids.includes(blocker)) return true;
    await Bun.sleep(5);
  }
  return false;
};

const fixture = async (): Promise<{
  owner: Awaited<ReturnType<typeof requireWorkspaceMembership>>;
  guest: Awaited<ReturnType<typeof requireChannelById>>;
  oldBookmark: Awaited<ReturnType<typeof addBookmark>>['bookmark'];
  incidentId: string;
  now: Date;
}> =>
  await cloned.db.transaction().execute(async (db) => {
    const room = await aRoom(db, ['owner', 'guest']);
    const owner = await requireWorkspaceMembership(
      db,
      room.members['owner']?.userId ?? '',
      room.workspaceId,
    );
    const channel = await requireChannelById(db, owner.userId, room.channelId);
    const now = (
      await db
        .selectNoFrom(sql<Date>`statement_timestamp() - interval '1 second'`.as('now'))
        .executeTakeFirstOrThrow()
    ).now;
    const oldBookmark = (
      await addBookmark(db, fixedClock(new Date(now.getTime() - 120_000)), channel, {
        url: 'https://private.example/race-contract',
        title: 'Prior confidential share',
      })
    ).bookmark;
    const incidentId = messageId(now);
    await declareIncident(db, fixedClock(now), channel, { id: incidentId, severity: 1 });
    const guestId = room.members['guest']?.userId ?? '';
    await db
      .updateTable('workspace_members')
      .set({
        access_kind: 'guest',
        guest_since: new Date(now.getTime() - 60_000),
        guest_modules: ['chat'],
      })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', guestId)
      .execute();
    await db
      .updateTable('channel_members')
      .set({ joined_at: new Date(now.getTime() - 60_000) })
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', guestId)
      .execute();
    return {
      owner,
      guest: await requireChannelById(db, guestId, room.channelId),
      oldBookmark,
      incidentId,
      now,
    };
  });

describe('integration: guest collaboration writes after independent scope changes', () => {
  for (const operation of ['revoke', 'regrant', 'convert'] as const) {
    test.each(['bookmark', 'incident'] as const)(
      `${operation} commits before a waiting %s writer rechecks its captured context`,
      async (kind) => {
        const f = await fixture();
        const at = new Date(f.now.getTime() + 1);
        const held = Promise.withResolvers<number>();
        const release = Promise.withResolvers<undefined>();
        const changing = cloned.db.transaction().execute(async (db) => {
          await sql`set local lock_timeout = '4s'`.execute(db);
          if (operation === 'convert') {
            await convertGuest(
              db,
              fixedClock(at),
              f.owner,
              f.guest.userId,
              { confirmFullAccess: true },
              chatWorkspaceChannels,
            );
          } else {
            await updateGuestAccess(
              db,
              fixedClock(at),
              f.owner,
              f.guest.userId,
              { channelIds: [] },
              chatWorkspaceChannels,
              true,
            );
            if (operation === 'regrant') {
              await updateGuestAccess(
                db,
                fixedClock(at),
                f.owner,
                f.guest.userId,
                { channelIds: [f.guest.channelId] },
                chatWorkspaceChannels,
                true,
              );
            }
          }
          held.resolve(await pidOf(db));
          await release.promise;
        });
        const started = Promise.withResolvers<number>();
        let writing: Promise<string> | undefined;
        let waited = false;
        try {
          const blocker = await Promise.race([
            held.promise,
            changing.then(() => {
              throw new Error('Editor ended before its witness');
            }),
          ]);
          writing = cloned.db
            .transaction()
            .execute(async (db) => {
              await sql`set local lock_timeout = '4s'`.execute(db);
              started.resolve(await pidOf(db));
              if (kind === 'bookmark') {
                await addBookmark(db, fixedClock(new Date(at.getTime() + 1)), f.guest, {
                  url: f.oldBookmark.url,
                  title: 'New guest share',
                });
              } else {
                await changeIncident(
                  db,
                  fixedClock(new Date(at.getTime() + 1)),
                  f.guest,
                  f.incidentId,
                  { severity: 3 },
                );
              }
              return 'accepted';
            })
            .catch((failure: unknown) => {
              if (failure instanceof AppError) return failure.body.code;
              throw failure;
            });
          waited = await blockedBy(await started.promise, blocker, writing);
        } finally {
          release.resolve(undefined);
          await changing;
        }
        const result = await writing;
        expect(waited).toBe(true);
        const expected =
          operation === 'revoke'
            ? 'CHANNEL_NOT_FOUND'
            : operation === 'regrant' && kind === 'incident'
              ? 'INCIDENT_NOT_FOUND'
              : 'accepted';
        expect(result).toBe(expected);
        const full = await requireChannelById(cloned.db, f.owner.userId, f.guest.channelId);
        const bookmarks = await channelBookmarks(cloned.db, full);
        if (kind === 'bookmark') {
          const shared = bookmarks.find((row) => row.url === f.oldBookmark.url);
          if (operation === 'revoke') expect(shared?.id).toBe(f.oldBookmark.id);
          else if (operation === 'convert') {
            expect(shared?.id).toBe(f.oldBookmark.id);
            expect(shared?.title).toBe(f.oldBookmark.title);
          } else {
            expect(shared?.id === f.oldBookmark.id).toBe(false);
            expect(shared?.title).toBe('New guest share');
            expect(shared?.addedBy?.id).toBe(f.guest.userId);
          }
        }
        expect((await channelIncident(cloned.db, full))?.severity).toBe(
          kind === 'incident' && operation === 'convert' ? 3 : 1,
        );
      },
    );
  }
});
