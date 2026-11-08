import { Elysia, type AnyElysia } from 'elysia';
import type { ChatRouteDependencies } from './dependencies';
import {
  OlderPageQuery,
  SaveSearchRequest,
  SetKnowledgeRequest,
  type Message,
  type SavedSearch,
  type SavedSearchPage,
} from '@purlay/types';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { setKnowledge } from '../messages/knowledge';
import { listSearches, saveSearch, removeSearch } from '../search/saved-searches';
import type { ResolveDependencies } from '../messages/threads';
import type { HistoryDependencies } from './messages';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';

type Dependencies = HistoryDependencies & ResolveDependencies;

const putKnowledge = async (
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

const readSavedSearches = async (
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

const putSavedSearch = async (
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

const deleteSavedSearch = async (
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

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const knowledgeRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia()
    .put(
      '/api/messages/:messageId/knowledge',
      async ({ request, params, body }) =>
        await putKnowledge(context, request, params.messageId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/saved-searches',
      async ({ request, params }) => await readSavedSearches(context, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/saved-searches/:searchId',
      async ({ request, params, body }) =>
        await putSavedSearch(context, request, params.workspaceId, params.searchId, body),
    )
    .delete(
      '/api/workspaces/:workspaceId/saved-searches/:searchId',
      async ({ request, params, set }) => {
        await deleteSavedSearch(context, request, params.workspaceId, params.searchId);
        set.status = 204;
        return null;
      },
    );
