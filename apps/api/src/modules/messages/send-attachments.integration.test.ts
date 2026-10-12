/**
 * A send that carries attachments (D-109 §3, §5, §7): the sender's own uploads, unattached, in this
 * workspace, linked in the transaction that writes the message — with the bytes moved onto the
 * workspace's count (`SCHEMA.md` I-7) — or the whole send refused and nothing written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type Executor,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { send, sendMessage } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

/** An upload of this member's, unattached, of `bytes` bytes. */
const anUpload = async (db: Executor, room: Room, name: string, bytes = 5): Promise<string> => {
  const context = await requireWorkspaceMembership(db, member(room, name).userId, room.workspaceId);
  const id = anId();
  await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
    context,
    { id, name: `${id}.txt`, bytes: new Uint8Array(bytes).fill(7) },
  );
  return id;
};

/** An upload of this person's, made in a workspace they also belong to. */
const herOwnElsewhere = async (db: Executor, elsewhere: Room, userId: string): Promise<string> => {
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: elsewhere.workspaceId,
      user_id: userId,
      role: 'member',
      joined_at: NOW,
    })
    .execute();
  const context = await requireWorkspaceMembership(db, userId, elsewhere.workspaceId);
  const id = anId();
  await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
    context,
    { id, name: `${id}.txt`, bytes: new Uint8Array(3).fill(7) },
  );
  return id;
};

const used = async (db: Executor, room: Room): Promise<number> =>
  Number(
    (
      await db
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow()
    ).storage_used_bytes,
  );

const refusalOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

const recordingBus = (): { bus: EventBus; frames: ServerFrame[] } => {
  const frames: ServerFrame[] = [];
  const bus: EventBus = {
    publish: (_topic, frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, frames };
};

describe('integration: a send carrying attachments', () => {
  test('links them, answers and announces them in upload order, and counts their bytes once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const first = await anUpload(db, room, 'alice', 5);
      const second = await anUpload(db, room, 'alice', 7);
      const { bus, frames } = recordingBus();
      const dependencies = { atomically: atomicallyOn(db), clock, bus };
      const id = anId();
      const input = { id, content: 'look', attachmentIds: [second, first] };

      const message = await send(dependencies, member(room, 'alice').context, input);
      expect(message.attachments.map((a) => a.id)).toEqual([first, second]);
      const created = frames.find((f) => f.event === 'MESSAGE_CREATED');
      expect(created?.event === 'MESSAGE_CREATED' ? created.data.attachments : []).toEqual(
        message.attachments,
      );
      const linked = await db
        .selectFrom('attachments')
        .select('message_id')
        .where('id', 'in', [first, second])
        .execute();
      expect(linked.map((row) => row.message_id)).toEqual([id, id]);
      expect(await used(db, room)).toBe(12);

      // The same send again is the same message: nothing is linked or counted twice.
      const again = await send(dependencies, member(room, 'alice').context, input);
      expect(again.attachments).toEqual(message.attachments);
      expect(await used(db, room)).toBe(12);
    });
  });

  test('may be its attachments alone, with no words', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const upload = await anUpload(db, room, 'alice');
      const sent = await sendMessage(db, clock, member(room, 'alice').context, {
        id: anId(),
        content: '',
        attachmentIds: [upload],
      });
      expect(sent.message.content).toBe('');
      expect(sent.message.attachments.map((a) => a.id)).toEqual([upload]);
    });
  });

  test('no words and nothing attached is refused by name, before anything is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const refusal = await sendMessage(db, clock, member(room, 'alice').context, {
        id: anId(),
        content: '',
      }).then(
        () => null,
        (error: unknown) => (error instanceof AppError ? error.body : null),
      );
      if (refusal?.code !== 'VALIDATION_FAILED') throw new Error('not refused by name');
      expect(Object.keys(refusal.details.fields)).toEqual(['content']);
    });
  });

  test('anything that is not the sender’s own unattached upload here is 404, and nothing is written', async () => {
    // Committed for real, so a refusal is seen to take the message back with it.
    const cloned = await cloneIntegrationDatabase();
    try {
      const db = cloned.db;
      const room = await aRoom(db, ['alice', 'bob']);
      const elsewhere = await aRoom(db, ['carol']);
      const alice = member(room, 'alice').context;
      const sentAlready = await anUpload(db, room, 'alice');
      await sendMessage(db, clock, alice, {
        id: anId(),
        content: 'a',
        attachmentIds: [sentAlready],
      });
      const usedBefore = await used(db, room);
      const mine = await anUpload(db, room, 'alice');
      const cases = {
        unknown: anId(),
        'somebody else’s': await anUpload(db, room, 'bob'),
        'already sent': sentAlready,
        'her own, in another workspace': await herOwnElsewhere(
          db,
          elsewhere,
          member(room, 'alice').userId,
        ),
      };
      for (const [what, other] of Object.entries(cases)) {
        const id = anId();
        // In its own transaction, as both doors send: the refusal takes the message back with it.
        const refused = await refusalOf(
          atomicallyOn(db)(
            async (transaction) =>
              await sendMessage(transaction, clock, alice, {
                id,
                content: 'x',
                attachmentIds: [mine, other],
              }),
          ),
        );
        expect({ what, refused }).toEqual({ what, refused: 'ATTACHMENT_NOT_FOUND' });
        const written = await db.selectFrom('messages').select('id').where('id', '=', id).execute();
        expect({ what, written }).toEqual({ what, written: [] });
      }
      const still = await db
        .selectFrom('attachments')
        .select('message_id')
        .where('id', '=', mine)
        .executeTakeFirstOrThrow();
      expect(still.message_id).toBeNull();
      expect(await used(db, room)).toBe(usedBefore);
    } finally {
      await cloned.drop();
    }
  });
});
