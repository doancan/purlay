// The __ID__ module’s client: the two endpoints `module:new` made (`packages/types/src/endpoints.ts`).
import {
  __PASCAL__Item,
  __PASCAL__ItemList,
  type Create__PASCAL__ItemRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface __PASCAL__Api {
  /** The workspace’s rows, newest first. */
  readonly list__PASCAL__: (workspaceId: string, signal?: AbortSignal) => Promise<__PASCAL__Item[]>;
  readonly create__PASCAL__Item: (
    workspaceId: string,
    input: Create__PASCAL__ItemRequest,
  ) => Promise<__PASCAL__Item>;
}

export const create__PASCAL__Api = (http: Http): __PASCAL__Api => ({
  list__PASCAL__: (workspaceId, signal) =>
    http.request('GET', `/api/workspaces/${at(workspaceId)}/__ID__`, __PASCAL__ItemList, options({}, signal)),
  create__PASCAL__Item: (workspaceId, input) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/__ID__`,
      __PASCAL__Item,
      options({ body: input }),
    ),
});
