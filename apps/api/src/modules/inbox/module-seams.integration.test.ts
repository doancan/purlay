/**
 * What a worker's visit and a fact's consumer may tell the build (D-283 §2, D-286): a notice with no actor and a follow-up fact,
 * both in the caller's transaction, as the calling module only, for the workspace the framework handed out, announced after the
 * commit; and the chain of facts a consumer can start is bounded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { defineFact, messageId } from '@purlay/types';
import type { EventBus } from '../../platform/events';
import { notificationSink } from './sink';
import { createMetricsRegistry } from '../../platform/metrics';
import { aMovableClock, aRecordingLogger, NOW } from '../../testing/doubles';
import { NOTE_CREATED, NOTES, WIKI, aPublishWorld, aWorkspaceRow } from '../../testing/facts';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { claimDue, deliver } from '../../platform/outbox-drain';
import { FACT_CHAIN_DEPTH_MAX, factRoutingOf } from '../../platform/outbox';
import type { FactConsumer } from '../../platform/fact-consumers';
import { inWorkspace, moduleSeams, noSeams } from '../../platform/ports/module-seams';
import type { ModuleNotice, WrittenNotice } from '../../platform/ports/notification-sink';
import { mintTurn } from '../../platform/workspace-turn';
import type { ModuleManifest } from '../../platform/module-kit/manifest';
import { OUTBOX_PENDING_MAX_DEFAULT } from '../../platform/config';

/** A fact of wiki's own, which shelf consumes: what a consumer of notes publishes as a consequence. */
const WIKI_INDEXED = defineFact({
  type: 'wiki.indexed',
  owner: 'wiki',
  absent: 'drop',
  schema: Type.Object({ noteId: Type.String({ maxLength: 36 }) }),
});

const wiki: ModuleManifest = { ...WIKI, publishes: ['wiki.indexed'] };
const shelf: ModuleManifest = {
  id: 'shelf',
  requires: [],
  optional: ['wiki'],
  degrades: { wiki: 'it shelves nothing' },
  provides: [],
  budget: { none: 'a test module' },
  consumes: ['wiki.indexed'],
};
const BUILD = [NOTES, wiki, shelf];

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
  await sql`delete from inbox_entries`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const registry = createMetricsRegistry();
const WRITTEN = registry.counter('seam_written', 'notices written', ['module', 'kind']);
const COLLAPSED = registry.counter('seam_collapsed', 'notices collapsed', ['module', 'kind']);

/** The real sink for `module`, with `wiki_done` declared by wiki and `other_kind` by shelf; the announced notices are kept. */
const seamsOf = (
  module: string,
  announced: WrittenNotice[][] = [],
): ReturnType<typeof moduleSeams> => {
  const sink = notificationSink({
    module,
    clock: aMovableClock(NOW),
    kinds: new Map([
      ['wiki_done', 'wiki'],
      ['other_kind', 'shelf'],
    ]),
    bus: NO_BUS,
    log: aRecordingLogger().log,
    written: WRITTEN,
    collapsed: COLLAPSED,
    pushedKinds: new Set(),
  });
  const shared = {
    clock: aMovableClock(NOW),
    routing: factRoutingOf(BUILD, BUILD),
    dropped: DROPPED,
    refused: REFUSED,
    pendingMax: OUTBOX_PENDING_MAX_DEFAULT,
  };
  const seams = moduleSeams(module, sink, shared);
  return {
    ...seams,
    announce: async (written): Promise<void> => {
      announced.push([...written]);
      await sink.announce(written);
    },
  };
};
const DROPPED = registry.counter('seam_dropped', 'facts dropped', ['module', 'fact']);
const REFUSED = registry.counter('seam_refused', 'facts refused', ['module', 'fact']);
const NO_BUS: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const NOTHING = '00000000-0000-7000-8000-000000000000';

const notice = (recipientId: string, kind = 'wiki_done'): ModuleNotice => ({
  kind,
  recipientId,
  subject: { type: 'note', id: messageId(NOW) },
  params: {},
});

const inboxOf = async (
  workspaceId: string,
): Promise<{ user_id: string; actor_id: string | null; module: string }[]> =>
  await cloned.db
    .selectFrom('inbox_entries')
    .select(['user_id', 'actor_id', 'module'])
    .where('workspace_id', '=', workspaceId)
    .execute();

describe('integration: a worker’s visit tells the build something', () => {
  test('a notice is written with no actor, as the module, and announced once the transaction has committed', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    const announced: WrittenNotice[][] = [];
    const turn = mintTurn({ workspaceId: room.workspaceId, modules: null });
    const result = await inWorkspace(
      seamsOf('wiki', announced),
      cloned.db,
      turn,
      async (_tx, seam) => {
        expect(announced).toEqual([]);
        return await seam.notify(notice(bob));
      },
    );
    expect(result?.recipientId).toBe(bob);
    expect(await inboxOf(room.workspaceId)).toEqual([
      { user_id: bob, actor_id: null, module: 'wiki' },
    ]);
    expect(announced.map((batch) => batch.length)).toEqual([1]);
  });

  test('a kind the module does not declare is refused, whether nobody declares it or another module does, and writes nothing', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    const turn = mintTurn({ workspaceId: room.workspaceId, modules: null });
    const announced: WrittenNotice[][] = [];
    for (const kind of ['nobody_declares_this', 'other_kind']) {
      const refused = await inWorkspace(
        seamsOf('wiki', announced),
        cloned.db,
        turn,
        async (_tx, seam) => await seam.notify(notice(bob, kind)),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
    }
    expect(await inboxOf(room.workspaceId)).toEqual([]);
    expect(announced).toEqual([]);
  });

  test('a person who is not a member is told nothing, and so is a workspace that lost the module', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const mallory = (await aUserRow(cloned.db, 'mallory')).userId;
    const alice = room.members['alice']?.userId ?? '';
    const seams = seamsOf('wiki');
    const member = mintTurn({ workspaceId: room.workspaceId, modules: null });
    expect(
      await inWorkspace(
        seams,
        cloned.db,
        member,
        async (_tx, seam) => await seam.notify(notice(mallory)),
      ),
    ).toBeUndefined();
    const lost = mintTurn({ workspaceId: room.workspaceId, modules: new Set(['shelf']) });
    expect(
      await inWorkspace(
        seams,
        cloned.db,
        lost,
        async (_tx, seam) => await seam.notify(notice(alice)),
      ),
    ).toBeUndefined();
    expect(await inboxOf(room.workspaceId)).toEqual([]);
  });

  test('a workspace the framework did not hand out is refused', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const forged = { workspaceId: room.workspaceId, modules: null };
    const refused = await inWorkspace(seamsOf('wiki'), cloned.db, forged, () =>
      Promise.resolve(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
  });

  test('the sink itself refuses a workspace nobody handed out, whoever calls it', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    const sink = notificationSink({
      module: 'wiki',
      clock: aMovableClock(NOW),
      kinds: new Map([['wiki_done', 'wiki']]),
      bus: NO_BUS,
      log: aRecordingLogger().log,
      written: WRITTEN,
      collapsed: COLLAPSED,
      pushedKinds: new Set(),
    });
    const forged = { workspaceId: room.workspaceId, modules: null };
    const refused = await cloned.db
      .transaction()
      .execute(async (tx) => await sink.notifyIn(tx, forged, notice(bob)))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(Error);
    expect(await inboxOf(room.workspaceId)).toEqual([]);
  });

  test('a visit that throws leaves no notice, no fact and nothing announced', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    const announced: WrittenNotice[][] = [];
    const turn = mintTurn({ workspaceId: room.workspaceId, modules: null });
    const failed = await inWorkspace(
      seamsOf('wiki', announced),
      cloned.db,
      turn,
      async (_tx, seam) => {
        await seam.notify(notice(bob));
        await seam.publishFact(WIKI_INDEXED, { noteId: 'n' });
        throw new Error('the sweep failed after it told them');
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(await inboxOf(room.workspaceId)).toEqual([]);
    expect(
      (
        await cloned.db
          .selectFrom('outbox')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .execute()
      ).length,
    ).toBe(0);
    expect(announced).toEqual([]);
  });

  test('publishes only a fact of its own module, in the transaction', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const turn = mintTurn({ workspaceId, modules: null });
    await inWorkspace(seamsOf('wiki'), cloned.db, turn, async (_tx, seam) => {
      await seam.publishFact(WIKI_INDEXED, { noteId: 'n' });
    });
    expect(
      await cloned.db
        .selectFrom('outbox')
        .select(['consumer', 'caused_by'])
        .where('workspace_id', '=', workspaceId)
        .execute(),
    ).toEqual([{ consumer: 'shelf', caused_by: null }]);
    const refused = await inWorkspace(seamsOf('wiki'), cloned.db, turn, async (_tx, seam) => {
      await seam.publishFact(NOTE_CREATED, { noteId: 'n', title: 't' });
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
  });

  test('a process with no seams refuses every call', async () => {
    const turn = mintTurn({ workspaceId: NOTHING, modules: null });
    const refused = await inWorkspace(
      noSeams,
      cloned.db,
      turn,
      async (_tx, seam) => await seam.notify(notice(NOTHING)),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
  });
});

describe('integration: a consumer tells the build something', () => {
  const published = async (workspaceId: string): Promise<void> => {
    const world = aPublishWorld(workspaceId, aMovableClock(NOW), BUILD);
    await cloned.db.transaction().execute(async (tx) => {
      const { publishFact } = await import('../../platform/outbox');
      await publishFact(
        tx,
        { ...world.context, routing: factRoutingOf(BUILD, BUILD) },
        NOTE_CREATED,
        { noteId: 'n', title: 't' },
      );
    });
  };

  const delivered = async (
    handle: FactConsumer,
    announced: WrittenNotice[][],
  ): Promise<string[]> => {
    const clock = aMovableClock(NOW);
    const { claimed } = await claimDue(cloned.db, {
      handles: [{ consumer: 'wiki', type: 'notes.created', shape: 1 }],
      batch: 5,
      clock,
    });
    const outcomes: string[] = [];
    for (const one of claimed) {
      outcomes.push(
        await deliver(
          cloned.db,
          one,
          { declaration: NOTE_CREATED, handle },
          { clock, log: aRecordingLogger().log, seams: seamsOf('wiki', announced) },
        ),
      );
    }
    return outcomes;
  };

  test('a notice and a follow-up fact are committed with the delivery, the fact says what caused it, and the notice is announced after', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    await published(room.workspaceId);
    const announced: WrittenNotice[][] = [];
    const outcomes = await delivered(async (fact, _tx, _ports, seam) => {
      await seam.notify(notice(bob));
      await seam.publishFact(WIKI_INDEXED, { noteId: 'n' });
      expect(announced).toEqual([]);
      return 'done';
    }, announced);
    expect(outcomes).toEqual(['delivered']);
    expect(await inboxOf(room.workspaceId)).toEqual([
      { user_id: bob, actor_id: null, module: 'wiki' },
    ]);
    const original = await cloned.db
      .selectFrom('outbox')
      .select('fact_id')
      .where('type', '=', 'notes.created')
      .executeTakeFirstOrThrow();
    const follow = await cloned.db
      .selectFrom('outbox')
      .select(['consumer', 'caused_by'])
      .where('type', '=', 'wiki.indexed')
      .execute();
    expect(follow).toEqual([{ consumer: 'shelf', caused_by: original.fact_id }]);
    expect(announced.map((batch) => batch.length)).toEqual([1]);
  });

  test('a delivery that fails after it told leaves no notice, no fact and nothing announced', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const bob = room.members['bob']?.userId ?? '';
    await published(room.workspaceId);
    const announced: WrittenNotice[][] = [];
    const outcomes = await delivered(async (_fact, _tx, _ports, seam) => {
      await seam.notify(notice(bob));
      await seam.publishFact(WIKI_INDEXED, { noteId: 'n' });
      throw new Error('down');
    }, announced);
    expect(outcomes).toEqual(['failed']);
    expect(await inboxOf(room.workspaceId)).toEqual([]);
    expect(
      (
        await cloned.db
          .selectFrom('outbox')
          .select('type')
          .where('type', '=', 'wiki.indexed')
          .execute()
      ).length,
    ).toBe(0);
    expect(announced).toEqual([]);
  });

  test('a chain of facts, each published by the delivery of the one before, ends at the depth the build allows', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const turn = mintTurn({ workspaceId, modules: null });
    const seams = seamsOf('wiki');
    let causedBy: string | undefined;
    for (let link = 1; link <= FACT_CHAIN_DEPTH_MAX; link += 1) {
      await cloned.db.transaction().execute(async (tx) => {
        await seams
          .bind(tx, turn, causedBy)
          .seam.publishFact(WIKI_INDEXED, { noteId: String(link) });
      });
      causedBy = (
        await cloned.db
          .selectFrom('outbox')
          .select('fact_id')
          .where('payload', '=', JSON.stringify({ noteId: String(link) }) as never)
          .executeTakeFirstOrThrow()
      ).fact_id;
    }
    const refused = await cloned.db
      .transaction()
      .execute(async (tx) => {
        await seams
          .bind(tx, turn, causedBy)
          .seam.publishFact(WIKI_INDEXED, { noteId: 'one too many' });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(String(refused)).toContain('chain');
    expect(OUTBOX_PENDING_MAX_DEFAULT).toBeGreaterThan(FACT_CHAIN_DEPTH_MAX);
  });
});
