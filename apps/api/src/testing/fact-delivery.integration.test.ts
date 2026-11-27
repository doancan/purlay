/**
 * The helper a module's own integration test publishes and delivers a fact with (`MODULE-GUIDE.md` §5, D-353), on real PostgreSQL:
 * the fake `notes` publishes and `wiki` consumes through `consumerOf`, composed as a process composes them, so what the helper says is
 * what the outbox and the handler did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { compose, type BundledModule } from '../composition';
import { consumerOf, type DeliveredFact } from '../platform/fact-consumers';
import { NOW, aMovableClock } from './doubles';
import { publishAndDeliver } from './fact-delivery';
import { NOTE_CREATED, NOTE_PINNED, NOTES, WIKI, aGrant, aWorkspaceRow } from './facts';

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

const clock = aMovableClock(NOW);

/** Wiki, as a module's slot is written: a typed handler for each fact it consumes, and what each was given kept for the test. */
const aWiki = (
  onCreated: (title: string) => Promise<'done' | 'skipped'> = () => Promise.resolve('done'),
): { readonly module: BundledModule; readonly told: DeliveredFact[] } => {
  const told: DeliveredFact[] = [];
  return {
    told,
    module: {
      manifest: WIKI,
      factConsumers: {
        ...consumerOf(NOTE_CREATED, async (fact) => {
          told.push(fact);
          // Typed by the declaration: `title` is a string here, with no cast.
          return await onCreated(fact.payload.title);
        }),
        ...consumerOf(NOTE_PINNED, async (fact) => {
          told.push(fact);
          return await Promise.resolve('done' as const);
        }),
      },
    },
  };
};

const buildOf = (wiki: BundledModule): ReturnType<typeof compose> => {
  const notes: BundledModule = { manifest: NOTES };
  return compose([notes, wiki], [notes, wiki], 'open', [NOTE_CREATED, NOTE_PINNED]);
};

describe('integration: publishing and delivering a fact in a module’s test', () => {
  test('runs the consumer’s handler with the fact’s workspace, its id and its payload, and says it was delivered', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const wiki = aWiki();
    const delivered = await publishAndDeliver(cloned.db, buildOf(wiki.module), {
      workspaceId,
      fact: NOTE_CREATED,
      payload: { noteId: 'n1', title: 'Plan' },
      clock,
    });
    expect(delivered).toEqual({ wiki: 'delivered' });
    expect(wiki.told).toHaveLength(1);
    expect(wiki.told[0]).toMatchObject({
      type: 'notes.created',
      workspaceId,
      payload: { noteId: 'n1', title: 'Plan' },
    });
  });

  test('says what the handler chose: skipped, or pending again after a throw', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const skipping = aWiki(() => Promise.resolve('skipped'));
    expect(
      await publishAndDeliver(cloned.db, buildOf(skipping.module), {
        workspaceId,
        fact: NOTE_CREATED,
        payload: { noteId: 'n1', title: 'Plan' },
        clock,
      }),
    ).toEqual({ wiki: 'skipped' });
    const failing = aWiki(() => Promise.reject(new Error('the consumer fails')));
    expect(
      await publishAndDeliver(cloned.db, buildOf(failing.module), {
        workspaceId,
        fact: NOTE_CREATED,
        payload: { noteId: 'n2', title: 'Plan' },
        clock,
      }),
    ).toEqual({ wiki: 'pending' });
  });

  test('writes nothing for a consumer the workspace is not granted, so its handler is never asked', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, workspaceId, 'wiki', 'off');
    const wiki = aWiki();
    expect(
      await publishAndDeliver(cloned.db, buildOf(wiki.module), {
        workspaceId,
        fact: NOTE_PINNED,
        payload: { noteId: 'n1' },
        clock,
      }),
    ).toEqual({});
    expect(wiki.told).toEqual([]);
  });
});
