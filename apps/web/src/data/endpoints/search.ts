// Finding a message again: search, saved searches and saved messages.
import {
  SavedIds,
  SavedPage,
  SavedSearch,
  SavedSearchPage,
  SearchPage,
  type SaveSearchRequest,
  type SavedState,
  type SearchQuery,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface SearchApi {
  /** The words, in the channels the caller can see, newest first (D-105). */
  readonly search: (
    workspaceId: string,
    query: Omit<SearchQuery, 'before'> & { readonly before?: string | undefined },
    signal?: AbortSignal,
  ) => Promise<SearchPage>;
  readonly savedSearches: (
    workspaceId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<SavedSearchPage>;
  readonly saveSearch: (
    workspaceId: string,
    id: string,
    input: SaveSearchRequest,
  ) => Promise<SavedSearch>;
  readonly deleteSearch: (workspaceId: string, id: string) => Promise<void>;
  /** Saves a message for the caller, or moves its save to `state` (D-128). */
  readonly saveMessage: (messageId: string, state?: SavedState) => Promise<void>;
  readonly unsaveMessage: (messageId: string) => Promise<void>;
  readonly savedIds: (workspaceId: string, signal?: AbortSignal) => Promise<SavedIds>;
  readonly saved: (
    workspaceId: string,
    state: SavedState,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<SavedPage>;
}

export const createSearchApi = (http: Http): SearchApi => ({
  search: (workspaceId, query, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/search`,
      SearchPage,
      options({ query: { ...query } }, signal),
    ),
  savedSearches: (workspaceId, before, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/saved-searches`,
      SavedSearchPage,
      options({ query: { before } }, signal),
    ),
  saveSearch: (workspaceId, id, input) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/saved-searches/${at(id)}`,
      SavedSearch,
      options({ body: input }),
    ),
  deleteSearch: (workspaceId, id) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/saved-searches/${at(id)}`, options()),
  saveMessage: (messageId, state) =>
    http.send(
      'PUT',
      `/api/messages/${at(messageId)}/saved`,
      options({ body: state === undefined ? {} : { state } }),
    ),
  unsaveMessage: (messageId) =>
    http.send('DELETE', `/api/messages/${at(messageId)}/saved`, options()),
  savedIds: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/saved/ids`,
      SavedIds,
      options({}, signal),
    ),
  saved: (workspaceId, state, before, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/saved`,
      SavedPage,
      options({ query: before === undefined ? { state } : { state, before } }, signal),
    ),
});
