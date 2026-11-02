import type { Message, SetKnowledgeRequest } from '@purlay/types';

export const knowledgeInput = (root: Message): SetKnowledgeRequest => {
  const kept = root.thread?.knowledge;
  return {
    version: kept?.version ?? 0,
    isQuestion: kept?.isQuestion ?? false,
    assigneeId: kept?.assigneeId ?? null,
    acceptedAnswerId: kept?.acceptedAnswer?.id ?? null,
    decisionNote: kept?.decisionNote ?? '',
    decisionUrl: kept?.decisionUrl ?? null,
  };
};
