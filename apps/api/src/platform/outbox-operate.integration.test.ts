/**
 * The administrator's list of stuck facts (D-288 §12, D-353), on real PostgreSQL: a pending fact older than the overview's fifteen
 * minutes that waits for a delivery that could happen, and not one held on purpose or past its expiry. The routes around it are
 * `server.integration.test.ts`'s; this is the judgement, over a build that carries the consumers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { NOW } from '../testing/doubles';
import { aGrant, anOutboxRow, aWorkspaceRow, theGrants } from '../testing/facts';
import { listOutboxFacts } from './outbox-operate';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const MINUTE = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
/** A build that carries `wiki` and `shelf`, judged by the grants as every node judges them. */
const VIEW = { consumers: ['wiki', 'shelf'], granted: theGrants() };

describe('integration: the stuck facts', () => {
  test('leave out a fact held for a workspace not granted its consumer, and one past its expiry', async () => {
    const barred = await aWorkspaceRow(cloned.db);
    const granted = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, barred, 'wiki', 'off');
    await anOutboxRow(cloned.db, barred, { at: ago(60 * MINUTE) });
    const late = await anOutboxRow(cloned.db, granted, { at: ago(50 * MINUTE) });
    await anOutboxRow(cloned.db, granted, { at: ago(40 * MINUTE), expiresAt: ago(MINUTE) });
    await anOutboxRow(cloned.db, granted, { at: ago(5 * MINUTE) });
    // A consumer this build does not carry is not judged: nothing of this version would deliver it, so it is stuck.
    const unknown = await anOutboxRow(cloned.db, barred, {
      at: ago(30 * MINUTE),
      consumer: 'gone',
    });
    const page = await listOutboxFacts(cloned.db, { state: 'stuck' }, NOW, VIEW);
    expect(page.data.map(({ id }) => id)).toEqual([late.id, unknown.id]);
    expect(page.nextCursor).toBeNull();
  });

  test('read past a page of held facts, and say where to go on when the pages run out', async () => {
    const barred = await aWorkspaceRow(cloned.db);
    const granted = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, barred, 'wiki', 'off');
    for (let held = 0; held < 4; held += 1) {
      await anOutboxRow(cloned.db, barred, { at: ago((90 - held) * MINUTE) });
    }
    const first = await anOutboxRow(cloned.db, granted, { at: ago(50 * MINUTE) });
    const second = await anOutboxRow(cloned.db, granted, { at: ago(49 * MINUTE) });
    const page = await listOutboxFacts(cloned.db, { state: 'stuck', limit: 1 }, NOW, VIEW);
    expect(page.data.map(({ id }) => id)).toEqual([first.id]);
    expect(page.nextCursor).toBe(first.id);
    const rest = await listOutboxFacts(
      cloned.db,
      { state: 'stuck', limit: 1, after: first.id },
      NOW,
      VIEW,
    );
    expect(rest.data.map(({ id }) => id)).toEqual([second.id]);
    expect(rest.nextCursor).toBeNull();
    // Held facts that fill every page it reads: a short answer, and a cursor past what it read.
    for (let held = 0; held < 20; held += 1) {
      await anOutboxRow(cloned.db, barred, { at: ago((200 - held) * MINUTE) });
    }
    const short = await listOutboxFacts(cloned.db, { state: 'stuck', limit: 1 }, NOW, VIEW);
    expect(short.data).toEqual([]);
    expect(short.nextCursor).not.toBeNull();
  });
});
