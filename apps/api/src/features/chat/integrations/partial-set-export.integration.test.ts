/** A module disabled during an upgrade keeps exporting its pre-upgrade data (D-312). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { compositionFor } from '../../../composition';
import { exportWorkspace } from '../../../modules/export/export';
import { fixedClock } from '../../../platform/clock';
import { aRecordingLogger } from '../../../testing/doubles';
import { aMemoryStore } from '../../../testing/storage';
import { aRoom } from '../../../testing/rooms';
import { sendMessage } from '../messages/messages';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
describe('integration: webhook regression coverage', () => {
  test('missing new webhook tables do not omit a departed historical author with chat disabled', async () => {
    const room = await aRoom(cloned.db, ['owner', 'departed']);
    const author = room.members['departed'];
    if (author === undefined) throw new Error('no departed author');
    const now = new Date('2026-11-14T12:00:00.000Z');
    const clock = fixedClock(now);
    const sent = await cloned.db.transaction().execute(
      async (tx) =>
        await sendMessage(tx, clock, author.context, {
          id: messageId(now),
          content: 'Keep this answer after I leave',
        }),
    );
    await cloned.db.deleteFrom('channel_members').where('user_id', '=', author.userId).execute();
    await cloned.db.deleteFrom('workspace_members').where('user_id', '=', author.userId).execute();
    // Model an old chat set left inert by MODULES=none: legacy rows and link tables exist,
    // while the new set's tables have not been applied.
    await cloned.db.schema.dropTable('webhook_delivery_attempts').execute();
    await cloned.db.schema.dropTable('webhook_deliveries').execute();
    await cloned.db.schema.dropTable('outgoing_webhooks').execute();
    const catalogue = compositionFor('none').exportCatalogue;
    const scope = await catalogue.scopeOf(cloned.db, {
      kind: 'all',
      workspaceId: room.workspaceId,
    });
    expect(scope.absent).toContain('outgoing_webhooks');
    const workspace = await cloned.db
      .selectFrom('workspaces')
      .select(['id', 'slug', 'name'])
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow();
    const root = await mkdtemp(join(tmpdir(), 'purlay-partial-webhook-export-'));
    const target = join(root, 'export');
    try {
      await exportWorkspace(
        {
          database: cloned.db,
          clock,
          log: aRecordingLogger().log,
          storage: aMemoryStore(),
          catalogue,
        },
        workspace,
        scope,
        target,
      );
      const users = (await readFile(join(target, 'users.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string });
      const messages = (await readFile(join(target, 'messages.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; sender_id: string });
      expect(users.map((user) => user.id)).toContain(author.userId);
      expect(messages.find((message) => message.id === sent.message.id)?.sender_id).toBe(
        author.userId,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
