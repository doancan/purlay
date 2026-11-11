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
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { sharedIn } from './shared';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
describe('integration: Shared bounded volume', () => {
  test('integration: Shared remains bounded and finds an old source at 1,000 and 10,000 links', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      const context = await requireWorkspaceMembership(db, ada.userId, room.workspaceId);
      const measured: { rows: number; milliseconds: number }[] = [];
      for (let start = 0; start < 10_000; start += 1000) {
        const sources = Array.from({ length: 1000 }, (_, n) => ({
          id: messageId(new Date('2026-11-11T12:00:00Z')),
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: ada.userId,
          content: `http://intranet/invoices/${String(start + n)}`,
        }));
        await db.insertInto('messages').values(sources).execute();
        await db
          .insertInto('message_shared_links')
          .values(
            sources.map((source, n) => ({
              message_id: source.id,
              workspace_id: room.workspaceId,
              channel_id: room.channelId,
              link_key: createHash('sha256').update(source.content).digest('hex'),
              url: source.content,
              label: `Invoice ${String(start + n)} document`,
            })),
          )
          .execute();
        await db
          .deleteFrom('message_shared_jobs')
          .where('workspace_id', '=', room.workspaceId)
          .execute();
        await db
          .updateTable('shared_link_backfill')
          .set({ complete: true })
          .where('name', '=', 'links')
          .execute();
        if (start !== 0 && start !== 9000) continue;
        const began = performance.now();
        const page = await sharedIn(db, context, { view: 'links', limit: 50 });
        expect(page.data).toHaveLength(50);
        expect(page.nextCursor).not.toBeNull();
        expect(page.indexing).toBe(false);
        expect(
          (await sharedIn(db, context, { view: 'links', q: 'Invoice 0 document' })).data,
        ).toHaveLength(1);
        measured.push({
          rows: start + 1000,
          milliseconds: Math.round((performance.now() - began) * 100) / 100,
        });
      }
      console.info('Shared bounded page + old-link search, real SQL:', JSON.stringify(measured));
    }, cloned.db);
  });
});
