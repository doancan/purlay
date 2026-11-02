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
 * - **GitHub refusing the token is not GitHub failing** (D-23, amended; #884). A `401` is a token
 *   revoked or expired: it is written on the workspace's integration row, shown to its admins, and no
 *   call is made with it until it is replaced. A `403` or `429` that names when to come back
 *   (`Retry-After`, or `x-ratelimit-remaining: 0` with `x-ratelimit-reset`) pauses the workspace until
 *   then — kept in this process, as the call budget is (D-25: a node that has not learned of a pause
 *   learns it from its first refused call, so the cost of not sharing it is one request a node).
 * - **Only github.com links are cards**, whatever `GITHUB_API_URL` is: the contract narrows a link to
 *   github.com, and the API address is the configured one, as the sign-in's is.
 */
import { createHash } from 'node:crypto';
import type { Executor } from '@purlay/db';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { GitHubCardMetadata, GitHubLink } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import type { Logger } from '../../platform/logging';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import { githubTokenOf } from './github';

const CARD_TTL_MS = 5 * 60 * 1000;
export const NEGATIVE_TTL_MS = 60 * 60 * 1000;
export const UNAVAILABLE_TTL_MS = 60 * 1000;
/** How long GitHub has to answer before it is taken as not answering. */
const GITHUB_TIMEOUT_MS = 5_000;

/** How long a `429` that says nothing of when to return is waited out: GitHub's own advice. */
const DEFAULT_PAUSE_MS = 60 * 1000;
/** No pause is longer than the hour GitHub's primary limit resets in: a header is not trusted further. */
const MAX_PAUSE_MS = 60 * 60 * 1000;
const MIN_PAUSE_MS = 1000;

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

/** What GitHub's refusal of the workspace's token means: it is bad, or it is spent until a time. */
export type GitHubRefusal =
  | { readonly kind: 'token_invalid' }
  | { readonly kind: 'rate_limited'; readonly resumesAt: number };

/** Thrown for a refusal, so a caller tells it from GitHub failing (which throws a plain `Error`). */
export class GitHubRefused extends Error {
  readonly refusal: GitHubRefusal;
  constructor(refusal: GitHubRefusal) {
    super(`GitHub refused the token: ${refusal.kind}`);
    this.name = 'GitHubRefused';
    this.refusal = refusal;
  }
}

/** Seconds, or an HTTP date, as `Retry-After` is written; milliseconds from `now`, or null. */
const waitOf = (retryAfter: string, now: number): number | null => {
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  // An HTTP date has a day's name: `Date.parse` takes far more (a bare `-5` is a year) than GitHub writes.
  if (!/^[A-Za-z]{3},/.test(retryAfter)) return null;
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? null : date - now;
};

/**
 * What a response says of the token, if it says anything: `401` is the token being bad; `403` and `429`
 * with a time to return are the quota being spent (a primary limit says `x-ratelimit-remaining: 0` and
 * when it resets, a secondary one `Retry-After`); a `429` without either is waited out for a minute. Any
 * other `403` is a refusal of one repository, not of the token, and is no refusal here.
 */
export const refusalOf = (
  response: { readonly status: number; readonly headers: Headers },
  now: number,
): GitHubRefusal | null => {
  if (response.status === 401) return { kind: 'token_invalid' };
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  const resetHeader = response.headers.get('x-ratelimit-reset');
  const reset = resetHeader === null ? Number.NaN : Number(resetHeader);
  const spent = response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset);
  const wait =
    (retryAfter === null ? null : waitOf(retryAfter, now)) ??
    (spent ? reset * 1000 - now : null) ??
    (response.status === 429 ? DEFAULT_PAUSE_MS : null);
  if (wait === null) return null;
  return {
    kind: 'rate_limited',
    resumesAt: now + Math.min(Math.max(wait, MIN_PAUSE_MS), MAX_PAUSE_MS),
  };
};

/** What saving a token learned of it from GitHub: the scopes a classic token carries, `null` for none. */
export interface TokenCheck {
  readonly scopes: string | null;
}

export interface GitHubApi {
  /** The item's card; `'missing'` for GitHub's 404. Anything else throws. */
  readonly item: (part: Part, token: string) => Promise<GitHubCardMetadata | 'missing'>;
  /** A pull request's checks and reviews, each absent when GitHub has none to say. Failing throws. */
  readonly checks: (part: Part, token: string) => Promise<Checks>;
  /** Whether GitHub accepts the token (`/rate_limit`, which costs no quota). A refusal throws `GitHubRefused`. */
  readonly check: (token: string) => Promise<TokenCheck>;
}

const headers = (token: string): Record<string, string> => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'purlay',
});

export const githubApi = (
  base = 'https://api.github.com',
  now: () => number = Date.now,
): GitHubApi => {
  /** A response that is not an answer: a refusal of the token, or GitHub failing. */
  const failure = (response: Response): Error => {
    const refusal = refusalOf(response, now());
    return refusal === null
      ? new Error(`GitHub answered ${String(response.status)}`)
      : new GitHubRefused(refusal);
  };
  return {
    item: async ({ owner, repo, kind, number }, token): Promise<GitHubCardMetadata | 'missing'> => {
      const path = kind === 'pull' ? 'pulls' : 'issues';
      const response = await fetch(`${base}/repos/${owner}/${repo}/${path}/${String(number)}`, {
        headers: headers(token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (response.status === 404) return 'missing';
      if (!response.ok) throw failure(response);
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
      if (!response.ok) throw failure(response);
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
    check: async (token): Promise<TokenCheck> => {
      const response = await fetch(`${base}/rate_limit`, {
        headers: headers(token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (!response.ok) throw failure(response);
      return { scopes: response.headers.get('x-oauth-scopes') };
    },
  };
};

/**
 * Workspaces GitHub told to wait, until when (epoch ms). Held in this process, as the call budget is
 * (`GITHUB_CALL_BUDGET`): the seam a shared implementation replaces for several nodes (D-25).
 */
export interface GitHubPauses {
  /** When the workspace may call GitHub again, or null if it may now. */
  readonly until: (workspaceId: string, now: number) => number | null;
  /** Pauses it until `resumesAt`; a longer pause already there stays. */
  readonly pause: (workspaceId: string, resumesAt: number) => void;
}

export const inProcessPauses = (): GitHubPauses => {
  const resumes = new Map<string, number>();
  return {
    until: (workspaceId, now): number | null => {
      const at = resumes.get(workspaceId);
      if (at === undefined) return null;
      if (at > now) return at;
      resumes.delete(workspaceId);
      return null;
    },
    pause: (workspaceId, resumesAt): void => {
      resumes.set(workspaceId, Math.max(resumesAt, resumes.get(workspaceId) ?? 0));
    },
  };
};

/**
 * Asks GitHub whether the token it is given is good, before it is kept (#884): a token GitHub refuses
 * is `400` on the `token` field; one that cannot be checked — GitHub unreachable, failing or not taking
 * calls — is `503 GITHUB_UNAVAILABLE`, so a good token is not saved unseen nor a bad one saved at all.
 */
export const verifiedToken = async (
  github: GitHubApi,
  log: Logger,
  token: string,
): Promise<TokenCheck> => {
  try {
    return await github.check(token);
  } catch (error) {
    if (error instanceof GitHubRefused && error.refusal.kind === 'token_invalid') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'GitHub does not accept this token.',
        details: { fields: { token: 'GitHub does not accept this token' } },
      });
    }
    log.warn('GitHub could not say whether a token is good', { error });
    throw new AppError({
      code: 'GITHUB_UNAVAILABLE',
      message: 'GitHub could not be asked about this token. Try again in a moment.',
    });
  }
};

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
  /** Workspaces GitHub told to wait: no call is made for one until its time. */
  readonly pauses: GitHubPauses;
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
  const { database, clock, cipher, github, log, mayCallGitHub, pauses } = dependencies;
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
    .select(['updated_at', 'access_token_encrypted', 'token_invalid_at'])
    .where('workspace_id', '=', context.workspaceId)
    .where('access_token_encrypted', 'is not', null)
    .executeTakeFirst();
  if (integration === undefined) return null;
  // A token GitHub refused is no token: no card is drawn from the cache nor asked of GitHub until an
  // admin replaces it, which clears this.
  if (integration.token_invalid_at !== null) return null;
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

  const resumesAt = pauses.until(context.workspaceId, now.getTime());
  if (resumesAt !== null) {
    log.info('a card waits for GitHub to take calls again', {
      workspaceId: context.workspaceId,
      resumesAt: new Date(resumesAt).toISOString(),
    });
    return null;
  }
  const token = await githubTokenOf(database, cipher, log, context);
  if (token === null) return null;
  if (!(await mayCallGitHub(context.workspaceId))) {
    log.info('a card waits for GitHub calls to spare', { workspaceId: context.workspaceId });
    return null;
  }
  /**
   * What a refusal of the token comes to: a token GitHub called bad is written on the row it was read
   * from — and not on a replacement that landed while the call was out — and a spent quota pauses the
   * workspace. False for anything else, which is GitHub failing.
   */
  const refused = async (error: unknown): Promise<boolean> => {
    if (!(error instanceof GitHubRefused)) return false;
    const { refusal } = error;
    if (refusal.kind === 'rate_limited') {
      pauses.pause(context.workspaceId, refusal.resumesAt);
      log.warn('GitHub is not taking the workspace’s calls', {
        workspaceId: context.workspaceId,
        resumesAt: new Date(refusal.resumesAt).toISOString(),
      });
      return true;
    }
    await database
      .updateTable('github_integrations')
      .set({ token_invalid_at: now })
      .where('workspace_id', '=', context.workspaceId)
      .where('access_token_encrypted', '=', integration.access_token_encrypted)
      .where('token_invalid_at', 'is', null)
      .execute();
    log.warn('GitHub refused the workspace’s token: it was revoked or has expired', {
      workspaceId: context.workspaceId,
    });
    return true;
  };
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
      if (!(await refused(error))) {
        log.warn('GitHub did not answer a card’s checks', {
          workspaceId: context.workspaceId,
          error,
        });
      }
      ttl = UNAVAILABLE_TTL_MS;
    }
    await remember(database, key, url, { kind: 'card', card }, now, ttl);
    return card;
  } catch (error) {
    // A refusal of the token is the pause's or the flag's to hold off, and nothing is kept: the card is
    // drawn at once when the token is replaced or the quota is back.
    if (await refused(error)) return null;
    // Said, and held off for a minute so a GitHub outage is not asked about on every render.
    log.warn('GitHub did not answer an unfurl', { workspaceId: context.workspaceId, error });
    await remember(database, key, url, { kind: 'missing' }, now, UNAVAILABLE_TTL_MS);
    return null;
  }
};
