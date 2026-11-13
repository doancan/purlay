/** A bounded page and an old source search still work after a tenfold history increase. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { sharedIn } from './shared';

let cloned: ClonedDatabase | undefined;
let context: WorkspaceContext;
let channelId: string;
let userId: string;
let preparedRows = 0;
const measured: { rows: number; milliseconds: number }[] = [];
beforeAll(async () => {
  const local = await cloneIntegrationDatabase();
  cloned = local;
  const room = await aRoom(local.db, ['ada']);
  const ada = room.members['ada'];
  if (ada === undefined) throw new Error('no writer');
  context = await requireWorkspaceMembership(local.db, ada.userId, room.workspaceId);
  channelId = room.channelId;
  userId = ada.userId;
}, CLONE_HOOK_MS);
afterAll(async () => {
  try {
    await cloned?.drop();
  } finally {
    await closeIntegrationDatabase();
  }
  console.info('Shared bounded page + old-link search, real SQL:', JSON.stringify(measured));
}, DROP_HOOK_MS);
describe('integration: Shared bounded volume', () => {
  describe.each([1000, 10_000])('with %d links', (rows) => {
    beforeAll(async () => {
      const local = cloned;
      if (local === undefined) throw new Error('Missing owned volume database');
      if (preparedRows > rows) throw new Error('Volume scenarios must grow the same history');
      await local.db.transaction().execute(async (db) => {
        for (let start = preparedRows; start < rows; start += 1000) {
          const sources = Array.from({ length: 1000 }, (_, n) => ({
            id: messageId(new Date('2026-11-11T12:00:00Z')),
            workspace_id: context.workspaceId,
            channel_id: channelId,
            sender_id: userId,
            content: `http://intranet/invoices/${String(start + n)}`,
          }));
          await db.insertInto('messages').values(sources).execute();
          await db
            .insertInto('message_shared_links')
            .values(
              sources.map((source, n) => ({
                message_id: source.id,
                workspace_id: context.workspaceId,
                channel_id: channelId,
                link_key: createHash('sha256').update(source.content).digest('hex'),
                url: source.content,
                label: `Invoice ${String(start + n)} document`,
              })),
            )
            .execute();
        }
        await db
          .deleteFrom('message_shared_jobs')
          .where('workspace_id', '=', context.workspaceId)
          .execute();
        await db
          .updateTable('shared_link_backfill')
          .set({ complete: true })
          .where('name', '=', 'links')
          .execute();
      });
      preparedRows = rows;
    }, CLONE_HOOK_MS);

    test('integration: Shared remains bounded and finds an old source', async () => {
      const local = cloned;
      if (local === undefined) throw new Error('Missing owned volume database');
      await withRollback(async (db) => {
        const volume = await db
          .selectFrom('message_shared_links')
          .select((eb) => eb.fn.countAll<string>().as('rows'))
          .where('workspace_id', '=', context.workspaceId)
          .executeTakeFirstOrThrow();
        expect(Number(volume.rows)).toBe(rows);
        const began = performance.now();
        const page = await sharedIn(db, context, { view: 'links', limit: 50 });
        expect(page.data).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
        expect(page.indexing).toBe(false);
        expect(
          (await sharedIn(db, context, { view: 'links', q: 'Invoice 0 document' })).data,
        ).toHaveLength(1);
        measured.push({
          rows: Number(volume.rows),
          milliseconds: Math.round((performance.now() - began) * 100) / 100,
        });
      }, local.db);
    });
  });
});
