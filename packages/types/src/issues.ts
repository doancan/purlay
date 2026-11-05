/**
 * Issues (D-254): a workspace's list of things to do, the second module and the smallest that proves the
 * architecture — a title, a markdown body, open or done, who it is assigned to. Nothing else hangs off an issue.
 */
import { Type, type Static } from '@sinclair/typebox';
import { PAGE_LIMIT } from './api';
import { FromClient, Timestamp, Uuid } from './models';

/**
 * How many issues a workspace may hold. A count and not bytes: an issue is bounded by its own limits (a title and a body
 * of a few kilobytes), so the count bounds the table's share of a workspace to tens of megabytes with one comparison
 * under a lock the create already takes, where byte accounting would be a column kept in step by every write and a
 * second number for the operator to reason about. Generous: nobody's list is this long on purpose (D-254).
 */
export const ISSUES_PER_WORKSPACE_MAX = 10_000;

/** The longest title: one line, as a list shows it. */
export const ISSUE_TITLE_MAX = 200;
/** The longest body, in characters: markdown as long as a long message. */
export const ISSUE_BODY_MAX = 10_000;

export const IssueStatus = Type.Union([Type.Literal('open'), Type.Literal('done')]);
export type IssueStatus = Static<typeof IssueStatus>;

/**
 * An issue. `assigneeId` and `createdBy` are the people's ids — the workspace's members come from `/members` —
 * and are `null` for nobody. An erased account is taken off what was assigned to it, so `assigneeId` is `null` then;
 * `createdBy` stays, naming the anonymised account (D-256).
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

/** One line a person can read as it is: what a name may be (no newline, control or bidi override, which spoof `gpj<RLO>exe`). */
const Title = Type.String({ minLength: 1, maxLength: ISSUE_TITLE_MAX, format: 'name' });
/** Text that may span lines, and that the database can store: no NUL, no lone surrogate. */
const Body = Type.String({ maxLength: ISSUE_BODY_MAX, format: 'plain-text' });

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
