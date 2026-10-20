/**
 * Unfurling a GitHub link (D-23, `ARCHITECTURE.md` §8.3, D-112).
 *
 * - **Built from parts, never fetched as given.** The link is one the contract already narrowed to
 *   github.com, an owner, a repository, a kind and a number; the request to GitHub's API is made of
 *   those parts, so no address a person wrote is ever fetched (no SSRF).
 * - **With the workspace's token** (D-23), never a member's: every member sees the same card.
 * - **Cached for this workspace alone** (D-112): the key is the workspace and the link, so a private
 *   repository's card fetched with this workspace's token never reaches another.
 * - **A card for five minutes; nothing there for an hour**, so one dead link in a busy channel costs
 *   one request; **GitHub failing, or answering what is not a card, for a minute** — said in the log,
 *   answered as no card, never a 500 for a link.
 */
import { createHash } from 'node:crypto';
import type { Executor } from '@purlay/db';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { GitHubCardMetadata, GitHubLink } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import type { Logger } from '../../platform/logging';
import type { WorkspaceContext } from '../../platform/tenancy';
import { githubTokenOf } from './github';

const CARD_TTL_MS = 5 * 60 * 1000;
export const NEGATIVE_TTL_MS = 60 * 60 * 1000;
export const UNAVAILABLE_TTL_MS = 60 * 1000;
/** How long GitHub has to answer before it is taken as not answering. */
const GITHUB_TIMEOUT_MS = 5_000;

/** The contract's own pattern, so what is accepted and what is parsed cannot differ. */
const LINK = new RegExp(GitHubLink.pattern ?? '^$');

/** What GitHub sends for a pull request or an issue, as far as a card needs it: checked, not trusted. */
const GitHubItem = Type.Object({
  title: Type.String(),
  state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Object({ login: Type.String(), avatar_url: Type.String() }),
});

/** A cached answer: the card, or that there is none. */
const Cached = Type.Union([
  Type.Object({ kind: Type.Literal('card'), card: GitHubCardMetadata }),
  Type.Object({ kind: Type.Literal('missing') }),
]);

/** A pull request's checks and reviews, as GitHub's GraphQL API answers them (#423): checked, not trusted. */
const PullChecks = Type.Object({
  data: Type.Object({
    repository: Type.Object({
      pullRequest: Type.Object({
        reviewDecision: Type.Union([Type.String(), Type.Null()]),
        commits: Type.Object({
          nodes: Type.Array(
            Type.Object({
              commit: Type.Object({
                statusCheckRollup: Type.Union([Type.Object({ state: Type.String() }), Type.Null()]),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

type Checks = Pick<GitHubCardMetadata, 'ciStatus' | 'reviewDecision'>;

/** GitHub's words for a rollup and a decision, in the contract's; one GitHub may add later is left out. */
const CI: Readonly<Record<string, NonNullable<Checks['ciStatus']>>> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};
const REVIEW: Readonly<Record<string, NonNullable<Checks['reviewDecision']>>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

interface Part {
  readonly owner: string;
  readonly repo: string;
  readonly kind: 'pull' | 'issues';
  readonly number: number;
}

export interface GitHubApi {
  /** The item's card; `'missing'` for GitHub's 404. Anything else throws. */
  readonly item: (part: Part, token: string) => Promise<GitHubCardMetadata | 'missing'>;
  /** A pull request's checks and reviews, each absent when GitHub has none to say. Failing throws. */
  readonly checks: (part: Part, token: string) => Promise<Checks>;
}

const headers = (token: string): Record<string, string> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'purlay',
});

export const githubApi = (base = 'https://api.github.com'): GitHubApi => ({
  item: async ({ owner, repo, kind, number }, token): Promise<GitHubCardMetadata | 'missing'> => {
    const path = kind === 'pull' ? 'pulls' : 'issues';
    const response = await fetch(`${base}/repos/${owner}/${repo}/${path}/${String(number)}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
    const body: unknown = await response.json();
    if (!Value.Check(GitHubItem, body))
      throw new Error('GitHub answered something that is not an item');
    return {
      type: kind === 'pull' ? 'pr' : 'issue',
      repo: `${owner}/${repo}`,
      number,
      title: body.title,
      state: body.merged_at != null ? 'merged' : body.state,
      author: { login: body.user.login, avatarUrl: body.user.avatar_url },
    };
  },
  checks: async ({ owner, repo, number }, token): Promise<Checks> => {
    // Variables, never interpolation: the query is a constant and the parts are data.
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ query: CHECKS_QUERY, variables: { owner, name: repo, number } }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
    const body: unknown = await response.json();
    if (!Value.Check(PullChecks, body))
      throw new Error('GitHub answered something that is not checks');
    const { reviewDecision, commits } = body.data.repository.pullRequest;
    const rollup = commits.nodes[0]?.commit.statusCheckRollup?.state;
    const ciStatus = rollup === undefined ? undefined : CI[rollup];
    const review = reviewDecision === null ? undefined : REVIEW[reviewDecision];
    return {
      ...(ciStatus === undefined ? {} : { ciStatus }),
      ...(review === undefined ? {} : { reviewDecision: review }),
    };
  },
});

export interface UnfurlDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly github: GitHubApi;
  readonly log: Logger;
  /**
   * Whether this workspace may make one more call to GitHub now. Every call spends the workspace's own
   * token, whose hourly quota is GitHub's; a member asking for links nobody wrote must not spend it for
   * everyone. False is a plain link today, asked for again when there is room.
   */
  readonly mayCallGitHub: (workspaceId: string) => Promise<boolean>;
}

const remember = async (
  database: Executor,
  key: string,
  url: string,
  payload: Static<typeof Cached>,
  now: Date,
  ttl: number,
): Promise<void> => {
  const expires = new Date(now.getTime() + ttl);
  await database
    .insertInto('link_previews')
    .values({
      url_hash: key,
      url,
      payload: JSON.stringify(payload),
      fetched_at: now,
      expires_at: expires,
    })
    .onConflict((conflict) =>
      conflict.column('url_hash').doUpdateSet({
        payload: JSON.stringify(payload),
        fetched_at: now,
        expires_at: expires,
      }),
    )
    .execute();
};

export const unfurl = async (
  dependencies: UnfurlDependencies,
  context: WorkspaceContext,
  url: string,
): Promise<GitHubCardMetadata | null> => {
  const { database, clock, cipher, github, log, mayCallGitHub } = dependencies;
  const parts = LINK.exec(url);
  if (parts === null) return null;
  const [, owner = '', repo = '', kind = '', number = ''] = parts;
  const now = clock.now();
  // Which token the card would be fetched with, read before the cache: without one a link is a plain
  // link at once — a card kept from before the token was removed is not drawn — and the token's own
  // version is part of the key, so a card (or "nothing there") remembered under the old token is never
  // read under the new one. The old entries expire as every entry does (`jobs.ts`).
  const integration = await database
    .selectFrom('github_integrations')
    .select('updated_at')
    .where('workspace_id', '=', context.workspaceId)
    .where('access_token_encrypted', 'is not', null)
    .executeTakeFirst();
  if (integration === undefined) return null;
  const version = new Date(integration.updated_at).toISOString();
  // The workspace is part of the key: a card is this workspace's, fetched with its token.
  const key = createHash('sha256')
    .update(`${context.workspaceId}\n${version}\n${url}`)
    .digest('hex');

  const cached = await database
    .selectFrom('link_previews')
    .select('payload')
    .where('url_hash', '=', key)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (cached !== undefined && Value.Check(Cached, cached.payload)) {
    return cached.payload.kind === 'card' ? cached.payload.card : null;
  }

  const token = await githubTokenOf(database, cipher, log, context);
  if (token === null) return null;
  if (!(await mayCallGitHub(context.workspaceId))) {
    log.info('a card waits for GitHub calls to spare', { workspaceId: context.workspaceId });
    return null;
  }
  try {
    const part: Part = {
      owner,
      repo,
      kind: kind === 'pull' ? 'pull' : 'issues',
      number: Number(number),
    };
    const item = await github.item(part, token);
    if (item === 'missing') {
      await remember(database, key, url, { kind: 'missing' }, now, NEGATIVE_TTL_MS);
      return null;
    }
    if (item.type === 'issue') {
      await remember(database, key, url, { kind: 'card', card: item }, now, CARD_TTL_MS);
      return item;
    }
    // A pull request's checks and reviews are a second question; the card does not wait on it.
    let card: GitHubCardMetadata = item;
    let ttl = CARD_TTL_MS;
    try {
      if (!(await mayCallGitHub(context.workspaceId))) {
        // The card without its checks for now, kept a minute so they are asked about again soon.
        await remember(database, key, url, { kind: 'card', card }, now, UNAVAILABLE_TTL_MS);
        return card;
      }
      card = { ...item, ...(await github.checks(part, token)) };
    } catch (error) {
      // The card without them, said, and kept a minute so they are asked about again soon.
      log.warn('GitHub did not answer a card’s checks', {
        workspaceId: context.workspaceId,
        error,
      });
      ttl = UNAVAILABLE_TTL_MS;
    }
    await remember(database, key, url, { kind: 'card', card }, now, ttl);
    return card;
  } catch (error) {
    // Said, and held off for a minute so a GitHub outage is not asked about on every render.
    log.warn('GitHub did not answer an unfurl', { workspaceId: context.workspaceId, error });
    await remember(database, key, url, { kind: 'missing' }, now, UNAVAILABLE_TTL_MS);
    return null;
  }
};
