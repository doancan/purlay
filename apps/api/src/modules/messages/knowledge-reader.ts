import type { Executor } from '@purlay/db';
import { ACCEPTED_ANSWER_PREVIEW_MAX, type ThreadKnowledge } from '@purlay/types';

/** One bounded join for a whole page. Never copy a deleted answer or a former member's assignment. */
export const knowledgeFor = async (
  executor: Executor,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ThreadKnowledge>> => {
  const result = new Map<string, ThreadKnowledge>();
  if (ids.length === 0) return result;
  const rows = await executor
    .selectFrom('messages as root')
    .leftJoin('messages as answer', (join) =>
      join
        .onRef('answer.id', '=', 'root.accepted_answer_id')
        .onRef('answer.parent_id', '=', 'root.id')
        .onRef('answer.channel_id', '=', 'root.channel_id')
        .on('answer.deleted_at', 'is', null),
    )
    .leftJoin('channel_members as owner', (join) =>
      join
        .onRef('owner.channel_id', '=', 'root.channel_id')
        .onRef('owner.user_id', '=', 'root.question_assignee_id'),
    )
    .select([
      'root.id',
      'root.is_question',
      'root.knowledge_version',
      'root.decision_note',
      'root.decision_url',
      'owner.user_id as assignee_id',
      'answer.id as answer_id',
      'answer.content as answer_content',
    ])
    .where('root.id', 'in', ids)
    .where('root.parent_id', 'is', null)
    .where('root.deleted_at', 'is', null)
    .where('root.knowledge_version', '>', 0)
    .execute();
  for (const row of rows)
    result.set(row.id, {
      version: row.knowledge_version,
      isQuestion: row.is_question,
      assigneeId: row.assignee_id,
      acceptedAnswer:
        row.answer_id === null || row.answer_content === null
          ? null
          : {
              id: row.answer_id,
              content: row.answer_content
                .slice(0, ACCEPTED_ANSWER_PREVIEW_MAX)
                .replace(/[\uD800-\uDBFF]$/u, ''),
            },
      decisionNote: row.decision_note,
      decisionUrl: row.decision_url,
    });
  return result;
};
