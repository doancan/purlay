/**
 * Issues (D-254): a workspace's list of things to do, the second module and the smallest that proves the
 * architecture — a title, a markdown body, open or done, who it is assigned to. Nothing else hangs off an issue.
 */
import { Type, type Static } from '@sinclair/typebox';
import { PAGE_LIMIT } from './api';
import { FromClient, Timestamp, Uuid } from './models';

/** The longest title: one line, as a list shows it. */
export const ISSUE_TITLE_MAX = 200;
/** The longest body, in characters: markdown as long as a long message. */
export const ISSUE_BODY_MAX = 10_000;

export const IssueStatus = Type.Union([Type.Literal('open'), Type.Literal('done')]);
export type IssueStatus = Static<typeof IssueStatus>;

/**
 * An issue. `assigneeId` and `createdBy` are the people's ids — the workspace's members come from `/members` —
 * and are `null` for nobody, or for somebody whose account was erased.
 */
export const Issue = Type.Object({
  id: Uuid,
  title: Type.String(),
  body: Type.String(),
  status: IssueStatus,
  assigneeId: Type.Union([Uuid, Type.Null()]),
  createdBy: Type.Union([Uuid, Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Issue = Static<typeof Issue>;

/** `GET /api/workspaces/:workspaceId/issues` — newest first, keyset on `id`; `nextCursor` is the next page's `before`. */
export const IssuePage = Type.Object({
  data: Type.Array(Issue),
  nextCursor: Type.Union([Uuid, Type.Null()]),
});
export type IssuePage = Static<typeof IssuePage>;

export const IssueQuery = FromClient({
  status: Type.Optional(IssueStatus),
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type IssueQuery = Static<typeof IssueQuery>;

const Title = Type.String({ minLength: 1, maxLength: ISSUE_TITLE_MAX });
const Body = Type.String({ maxLength: ISSUE_BODY_MAX });

/** `POST /api/workspaces/:workspaceId/issues` — a new issue, open; the body defaults to empty, the assignee to nobody. */
export const CreateIssueRequest = FromClient({
  title: Title,
  body: Type.Optional(Body),
  assigneeId: Type.Optional(Type.Union([Uuid, Type.Null()])),
});
export type CreateIssueRequest = Static<typeof CreateIssueRequest>;

/** `PATCH /api/workspaces/:workspaceId/issues/:issueId` — what is given changes, at least one field. */
export const UpdateIssueRequest = FromClient(
  {
    title: Type.Optional(Title),
    body: Type.Optional(Body),
    status: Type.Optional(IssueStatus),
    assigneeId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  },
  { minProperties: 1 },
);
export type UpdateIssueRequest = Static<typeof UpdateIssueRequest>;
