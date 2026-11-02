import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type SetKnowledgeRequest } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom } from '../../testing/rooms';
import { sendMessage } from './messages';
import { readBuilt } from './reader';
import { setKnowledge } from './knowledge';
import { unresolvedIn } from './threads';
import { searchIn } from '../search/search';
import { tombstoneRows } from './tombstone';
import type { EventBus } from '../../platform/events';

afterAll(closeIntegrationDatabase);
const refusalOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    (): unknown => null,
    (error: unknown): unknown => error,
  );
const clock = fixedClock(new Date('2026-10-28T10:00:00Z'));
const bus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const empty: SetKnowledgeRequest = {
  version: 0,
  isQuestion: true,
  assigneeId: null,
  acceptedAnswerId: null,
  decisionNote: '',
  decisionUrl: null,
};

describe('integration: questions and decisions', () => {
  test('a marked question is listed unanswered; ownership, retries and stale saves are explicit', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('members missing');
      const { message } = await sendMessage(db, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Why four seconds?',
      });
      const deps = { atomically: atomicallyOn(db), clock, bus };
      for (const decisionUrl of [
        'not-a-url',
        'javascript:alert(1)',
        'https://name:secret@example.com',
      ]) {
        expect(
          await refusalOf(setKnowledge(deps, alice.userId, message.id, { ...empty, decisionUrl })),
        ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      }
      expect(
        await refusalOf(
          setKnowledge(deps, alice.userId, message.id, {
            ...empty,
            isQuestion: false,
            assigneeId: bob.userId,
          }),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      const input = { ...empty, assigneeId: bob.userId };
      const marked = await setKnowledge(deps, alice.userId, message.id, input);
      expect(marked.thread?.knowledge).toMatchObject({
        version: 1,
        isQuestion: true,
        assigneeId: bob.userId,
      });
      expect(await setKnowledge(deps, alice.userId, message.id, input)).toEqual(marked);
      const context = await requireWorkspaceMembership(db, alice.userId, alice.context.workspaceId);
      const page = await unresolvedIn(db, context, [alice.context.channelId], {
        unanswered: 'yes',
        assigneeId: bob.userId,
        order: 'oldest',
      });
      expect(page.data.map((m) => m.id)).toEqual([message.id]);
      expect(
        await refusalOf(
          setKnowledge(deps, bob.userId, message.id, { ...empty, decisionNote: 'Stale editor' }),
        ),
      ).toMatchObject({ body: { code: 'KNOWLEDGE_CONFLICT' } });
      expect((await readBuilt(db, message.id))?.thread?.knowledge?.decisionNote).toBe('');
    });
  });

  test('selected answers stay in this thread, are searchable, and reveal nothing after deletion', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('member missing');
      const post = async (content: string, parentId?: string): Promise<string> =>
        (
          await sendMessage(db, clock, alice.context, {
            id: messageId(clock.now()),
            content,
            ...(parentId === undefined ? {} : { parentId }),
          })
        ).message.id;
      const root = await post('Retry delay');
      const answer = await post('The upstream quota resets in four seconds.', root);
      const other = await post('Unrelated root');
      const otherReply = await post('Another thread’s reply', other);
      const deps = { atomically: atomicallyOn(db), clock, bus };
      expect(await refusalOf(setKnowledge(deps, alice.userId, answer, empty))).toMatchObject({
        body: { code: 'VALIDATION_FAILED' },
      });
      expect(
        await refusalOf(
          setKnowledge(deps, alice.userId, root, { ...empty, acceptedAnswerId: otherReply }),
        ),
      ).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
      expect(
        await refusalOf(
          setKnowledge(deps, alice.userId, root, { ...empty, acceptedAnswerId: other }),
        ),
      ).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
      const result = await setKnowledge(deps, alice.userId, root, {
        ...empty,
        acceptedAnswerId: answer,
        decisionNote: 'Respect upstream quota.',
        decisionUrl: 'https://github.com/acme/api/pull/42',
      });
      expect(result.thread?.knowledge?.acceptedAnswer).toEqual({
        id: answer,
        content: 'The upstream quota resets in four seconds.',
      });
      expect(result.thread?.resolvedAt).toBeNull();
      const context = await requireWorkspaceMembership(db, alice.userId, alice.context.workspaceId);
      expect(
        (
          await searchIn(db, context, [alice.context.channelId], {
            q: 'upstream quota',
            question: 'yes',
          })
        ).data.map((m) => m.id),
      ).toEqual([root]);
      await tombstoneRows(db, clock.now(), [answer]);
      expect((await readBuilt(db, root))?.thread?.knowledge?.acceptedAnswer).toBeNull();
      expect(
        await refusalOf(
          setKnowledge(deps, alice.userId, root, {
            ...empty,
            version: 1,
            acceptedAnswerId: answer,
          }),
        ),
      ).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
      await tombstoneRows(db, clock.now(), [root]);
      expect((await readBuilt(db, root))?.thread?.knowledge).toBeUndefined();
      expect(
        (
          await db
            .selectFrom('messages')
            .select('decision_note')
            .where('id', '=', root)
            .executeTakeFirst()
        )?.decision_note,
      ).toBe('');
    });
  });

  test('another workspace and a non-member of a visible channel cannot write metadata', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['erin'] });
      const other = await aRoom(db, ['stranger']);
      const alice = room.members['alice'];
      const stranger = other.members['stranger'];
      if (alice === undefined || stranger === undefined) throw new Error('members missing');
      const { message } = await sendMessage(db, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Private to this workspace',
      });
      const deps = { atomically: atomicallyOn(db), clock, bus };
      expect(await refusalOf(setKnowledge(deps, stranger.userId, message.id, empty))).toMatchObject(
        {
          body: { code: 'MESSAGE_NOT_FOUND' },
        },
      );
      expect(
        await refusalOf(
          setKnowledge(deps, room.outsiders['erin']?.userId ?? '', message.id, empty),
        ),
      ).toMatchObject({ body: { code: 'NOT_A_CHANNEL_MEMBER' } });
      expect(
        await refusalOf(
          setKnowledge(deps, alice.userId, message.id, { ...empty, assigneeId: stranger.userId }),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    });
  });
});
