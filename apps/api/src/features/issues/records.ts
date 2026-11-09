/**
 * Issues' answer to a module that links to one of its issues (D-291, `MODULES.md` §4): the issue's title as it is now, if the
 * workspace has it. Any member reads any issue (D-254), so the workspace is the only narrowing, and it is in the query; the
 * scope is the asker's workspace as the framework minted it, never one the caller names. An id that is no UUID, a kind of record
 * issues does not have, an issue of another workspace and one that was deleted are the same answer: none.
 */
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import type { RecordResolver } from '../../platform/ports/record-ref';
import type { IssuesDb } from './schema';

const ISSUE_RECORD_TYPE = 'issue';

export const issuesRecords: RecordResolver = {
  resolve: async ({ database, scope, type, id }) => {
    if (type !== ISSUE_RECORD_TYPE || !Value.Check(Uuid, id)) return undefined;
    const issues: IssuesDb = database;
    const issue = await issues
      .selectFrom('issues')
      .select('title')
      .where('workspace_id', '=', scope.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    return issue === undefined ? undefined : { label: issue.title };
  },
};
