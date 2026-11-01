/**
 * Creating a GitHub issue from a thread, as a write that can be recovered (D-246 §2, §4): which repositories a
 * person may choose, the request that creates and its idempotency key, and the four things it can come to.
 *
 * `created` — the issue exists and is linked to the root. `pending` — another request with this id is being
 * heard by GitHub now. `unknown` — GitHub did not answer, so whether it was made is not known; the same request
 * sent again asks GitHub's reads for the marker and never posts twice. `refused` — GitHub said no, with a closed
 * reason. Nothing here resolves the question.
 */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, GitHubWorkLink, Uuid } from './models';

export const GITHUB_ISSUE_TITLE_MAX = 256;
/** GitHub takes 65,536 characters; the marker and room for what GitHub counts differently are left. */
export const GITHUB_ISSUE_BODY_MAX = 60_000;

/** A repository the caller may choose: one both they and the App can reach. */
export const GitHubRepository = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  fullName: Type.String({ minLength: 3, maxLength: 140 }),
  private: Type.Boolean(),
});
export type GitHubRepository = Static<typeof GitHubRepository>;

/** `GET /api/workspaces/:workspaceId/github-repositories` — what the caller may choose, never more than a page. */
export const GITHUB_REPOSITORIES_MAX = 500;
export const GitHubRepositoryList = Type.Object({
  repositories: Type.Array(GitHubRepository, { maxItems: GITHUB_REPOSITORIES_MAX }),
});
export type GitHubRepositoryList = Static<typeof GitHubRepositoryList>;

/**
 * `POST /api/messages/:messageId/github-issue` — the title and body exactly as the person reviewed them (the
 * server adds only the marker, which the review showed), the repository by its number, and whether they chose
 * to copy the text of a channel that is not public. The same `clientRequestId` is the same request: sent again
 * it answers what became of the first, and with other content it is a conflict.
 */
export const CreateGitHubIssueRequest = FromClient({
  clientRequestId: Uuid,
  repositoryId: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1, maxLength: GITHUB_ISSUE_TITLE_MAX }),
  body: Type.String({ maxLength: GITHUB_ISSUE_BODY_MAX }),
  copyPrivateText: Type.Boolean(),
});
export type CreateGitHubIssueRequest = Static<typeof CreateGitHubIssueRequest>;

/**
 * The line a created issue ends with, by which a lost answer is found again through GitHub's reads. Made
 * from the request's own id, so the review can show the exact text before anything is sent.
 */
export const githubIssueMarker = (clientRequestId: string): string =>
  `<!-- purlay:${clientRequestId} -->`;

/** Why GitHub said no: no access to the repository, issues turned off there, a title or body it refused, or never made. */
export const GITHUB_ISSUE_REFUSALS = [
  'no-access',
  'issues-disabled',
  'invalid',
  'not-created',
] as const;
export type GitHubIssueRefusal = (typeof GITHUB_ISSUE_REFUSALS)[number];

export const GitHubIssueOutcome = Type.Union([
  Type.Object({ status: Type.Literal('created'), link: GitHubWorkLink }),
  Type.Object({ status: Type.Literal('pending') }),
  Type.Object({ status: Type.Literal('unknown') }),
  Type.Object({
    status: Type.Literal('refused'),
    reason: Type.Union(GITHUB_ISSUE_REFUSALS.map((reason) => Type.Literal(reason))),
  }),
]);
export type GitHubIssueOutcome = Static<typeof GitHubIssueOutcome>;
