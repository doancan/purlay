// The issues module’s client.
import {
  Issue,
  IssuePage,
  type CreateIssueRequest,
  type IssueQuery,
  type UpdateIssueRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface IssuesApi {
  /** The issues module's list, newest first, a page from `query.before` (D-254). */
  readonly issues: (
    workspaceId: string,
    query?: Pick<IssueQuery, 'status' | 'before'>,
    signal?: AbortSignal,
  ) => Promise<IssuePage>;
  readonly createIssue: (workspaceId: string, input: CreateIssueRequest) => Promise<Issue>;
  readonly updateIssue: (
    workspaceId: string,
    issueId: string,
    input: UpdateIssueRequest,
  ) => Promise<Issue>;
  readonly deleteIssue: (workspaceId: string, issueId: string) => Promise<void>;
}

export const createIssuesApi = (http: Http): IssuesApi => ({
  issues: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/issues`,
      IssuePage,
      options({ query: { ...query } }, signal),
    ),
  createIssue: (workspaceId, input) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/issues`,
      Issue,
      options({ body: input }),
    ),
  updateIssue: (workspaceId, issueId, input) =>
    http.request(
      'PATCH',
      `/api/workspaces/${at(workspaceId)}/issues/${at(issueId)}`,
      Issue,
      options({ body: input }),
    ),
  deleteIssue: (workspaceId, issueId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/issues/${at(issueId)}`, options()),
});
