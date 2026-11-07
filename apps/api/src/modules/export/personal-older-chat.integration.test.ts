/** A stopped module may still have an older schema; retained words keep their workspace context. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneIntegrationDatabase,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { personalExportCatalogue } from '../../export-catalogue';
import { sendMessage } from '../../features/chat/messages/messages';
import { fixedClock } from '../../platform/clock';
import { NOW, aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { exportPerson } from './personal';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);
const clock = fixedClock(NOW);

describe('integration: an older stopped chat’s personal export', () => {
  test('skips new private tables while keeping the workspace of a departed person’s retained message', async () => {
    const room = await aRoom(cloned.db, ['owner', 'person']);
    const person = room.members['person'];
    if (person === undefined) throw new Error('Missing person');
    await cloned.db.transaction().execute(async (transaction) => {
      await sendMessage(transaction, clock, person.context, {
        id: messageId(NOW),
        content: 'Retained handover',
      });
    });
    await cloned.db.deleteFrom('channel_members').where('user_id', '=', person.userId).execute();
    await cloned.db.deleteFrom('workspace_members').where('user_id', '=', person.userId).execute();
    // The same final table shape as chat/0006: chat is stopped, so its later set has not run.
    // DDL holds an exclusive lock; this is a clone, never the shared test database.
    await sql`drop table thread_reads, channel_read_scopes`.execute(cloned.db);
    const target = join(await mkdtemp(join(tmpdir(), 'purlay-older-chat-export-')), 'out');
    const { manifest } = await exportPerson(
      {
        database: cloned.db,
        clock,
        log: aRecordingLogger().log,
        storage: aMemoryStore(),
        personalCatalogue: personalExportCatalogue,
      },
      { id: person.userId, username: person.username },
      target,
    );
    expect(manifest.tables['thread_reads']).toBe(0);
    expect(manifest.tables['channel_read_scopes']).toBe(0);
    const spaces = (await readFile(join(target, 'workspaces.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { readonly id: string });
    expect(spaces.map((space) => space.id)).toEqual([room.workspaceId]);
    expect(manifest.tables['messages']).toBe(1);
  });
});
