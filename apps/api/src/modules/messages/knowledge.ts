import { sql } from '@purlay/db';
import type { Message, SetKnowledgeRequest } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { requireMessageById, requireChannelMember } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishThreadUpdated,
} from '../../platform/events';
import { requireLiveSession } from '../auth/sessions';
import { readBuilt } from './reader';
import type { ResolveDependencies } from './threads';

const invalid = (field: string, message: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message,
    details: { fields: { [field]: message } },
  });

/** Versioned, idempotent metadata; the same channel authority as resolving, with no notification. */
export const setKnowledge = async (
  dependencies: ResolveDependencies,
  userId: string,
  messageId: string,
  input: SetKnowledgeRequest,
  sessionId?: string,
): Promise<Message> => {
  const { atomically, clock, bus, log = NO_LOG } = dependencies;
  const outcome = await atomically(async (db) => {
    if (sessionId !== undefined) await requireLiveSession(db, clock, sessionId);
    const target = await requireMessageById(db, userId, messageId);
    await requireChannelMember(db, target.context, 'Join the channel to update its questions.');
    if (target.parentId !== null) throw invalid('messageId', 'Only a root can keep a decision.');
    const root = await db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', messageId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (root.deleted_at !== null)
      throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
    if (!input.isQuestion && input.assigneeId !== null)
      throw invalid('assigneeId', 'Only a question can have an owner.');
    if (input.decisionUrl !== null) {
      let url: URL;
      try {
        url = new URL(input.decisionUrl);
      } catch {
        throw invalid('decisionUrl', 'Use an HTTP or HTTPS link.');
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw invalid('decisionUrl', 'Use an HTTP or HTTPS link without credentials.');
      }
    }
    if (input.assigneeId !== null) {
      const owner = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', target.context.channelId)
        .where('user_id', '=', input.assigneeId)
        .forKeyShare()
        .executeTakeFirst();
      if (owner === undefined)
        throw invalid('assigneeId', 'Choose a current member of this channel.');
    }
    if (input.acceptedAnswerId !== null) {
      const answer = await db
        .selectFrom('messages')
        .select('id')
        .where('id', '=', input.acceptedAnswerId)
        .where('parent_id', '=', messageId)
        .where('channel_id', '=', target.context.channelId)
        .where('deleted_at', 'is', null)
        // A delete locks the reply before updating its root's counters. KEY SHARE protects the
        // reference without waiting on that soft delete while we hold the root. The reader always
        // checks deleted_at, including when the delete commits after this selection.
        .forKeyShare()
        .executeTakeFirst();
      if (answer === undefined)
        throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Answer not found.' });
    }
    const same =
      root.is_question === input.isQuestion &&
      root.question_assignee_id === input.assigneeId &&
      root.accepted_answer_id === input.acceptedAnswerId &&
      root.decision_note === input.decisionNote &&
      root.decision_url === input.decisionUrl;
    if (!same && root.knowledge_version !== input.version)
      throw new AppError({
        code: 'KNOWLEDGE_CONFLICT',
        message: 'This decision changed. Review the latest version before saving.',
      });
    let version = root.state_version;
    if (!same) {
      const written = await db
        .updateTable('messages')
        .set({
          is_question: input.isQuestion,
          question_assignee_id: input.assigneeId,
          accepted_answer_id: input.acceptedAnswerId,
          decision_note: input.decisionNote,
          decision_url: input.decisionUrl,
          decision_updated_by:
            root.decision_note === input.decisionNote && root.decision_url === input.decisionUrl
              ? root.decision_updated_by
              : userId,
          knowledge_version: sql<number>`knowledge_version + 1`,
          state_version: sql<number>`state_version + 1`,
          updated_at: clock.now(),
        })
        .where('id', '=', messageId)
        .returning('state_version')
        .executeTakeFirstOrThrow();
      version = written.state_version;
    }
    const message = await readBuilt(db, messageId);
    if (message === undefined || message.thread === null)
      throw new Error('locked root disappeared');
    return { message, version, changed: !same, thread: message.thread };
  });
  if (outcome.changed)
    await publishAfterCommit(log, [
      [
        publication('THREAD_UPDATED', () =>
          publishThreadUpdated(
            bus,
            clock,
            { channelId: outcome.message.channelId, messageId, thread: outcome.thread },
            outcome.version,
          ),
        ),
      ],
    ]);
  return outcome.message;
};
