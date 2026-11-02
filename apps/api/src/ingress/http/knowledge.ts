import {
  OlderPageQuery,
  SaveSearchRequest,
  SetKnowledgeRequest,
  type Message,
  type SavedSearch,
  type SavedSearchPage,
} from '@purlay/types';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireLiveSession } from '../../modules/auth/sessions';
import { setKnowledge } from '../../modules/messages/knowledge';
import { listSearches, saveSearch, removeSearch } from '../../modules/search/saved-searches';
import type { ResolveDependencies } from '../../modules/messages/threads';
import type { HistoryDependencies } from './messages';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

type Dependencies = HistoryDependencies & ResolveDependencies;

export const putKnowledge = async (
  deps: Dependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<Message> => {
  const { userId, sessionId } = await requireSession(deps.auth, request);
  return await setKnowledge(
    deps,
    userId,
    messageId,
    validated(SetKnowledgeRequest, body),
    sessionId,
  );
};

export const readSavedSearches = async (
  deps: HistoryDependencies,
  request: Request,
  workspaceId: string,
): Promise<SavedSearchPage> => {
  const { userId } = await requireSession(deps.auth, request);
  const context = await requireWorkspaceMembership(deps.database, userId, workspaceId);
  return await listSearches(
    deps.database,
    context,
    validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] })),
  );
};

export const putSavedSearch = async (
  deps: Dependencies,
  request: Request,
  workspaceId: string,
  id: string,
  body: unknown,
): Promise<SavedSearch> => {
  const { userId, sessionId } = await requireSession(deps.auth, request);
  const input = validated(SaveSearchRequest, body);
  return await deps.atomically(async (db) => {
    await requireLiveSession(db, deps.clock, sessionId);
    const context = await requireWorkspaceMembership(db, userId, workspaceId);
    return await saveSearch(db, deps.clock, context, id, input);
  });
};

export const deleteSavedSearch = async (
  deps: Dependencies,
  request: Request,
  workspaceId: string,
  id: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(deps.auth, request);
  await deps.atomically(async (db) => {
    await requireLiveSession(db, deps.clock, sessionId);
    const context = await requireWorkspaceMembership(db, userId, workspaceId);
    await removeSearch(db, context, id);
  });
};
