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

export interface GitHubApi {
  /** The item's card; `'missing'` for GitHub's 404. Anything else throws. */
  readonly item: (
    part: { owner: string; repo: string; kind: 'pull' | 'issues'; number: number },
    token: string,
  ) => Promise<GitHubCardMetadata | 'missing'>;
}

export const githubApi = (base = 'https://api.github.com'): GitHubApi => ({
  item: async ({ owner, repo, kind, number }, token): Promise<GitHubCardMetadata | 'missing'> => {
    const path = kind === 'pull' ? 'pulls' : 'issues';
    const response = await fetch(`${base}/repos/${owner}/${repo}/${path}/${String(number)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'purlay',
      },
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
});

export interface UnfurlDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly github: GitHubApi;
  readonly log: Logger;
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
  const { database, clock, cipher, github, log } = dependencies;
  const parts = LINK.exec(url);
  if (parts === null) return null;
  const [, owner = '', repo = '', kind = '', number = ''] = parts;
  const now = clock.now();
  // The workspace is part of the key: a card is this workspace's, fetched with its token.
  const key = createHash('sha256').update(`${context.workspaceId}\n${url}`).digest('hex');

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
  try {
    const item = await github.item(
      { owner, repo, kind: kind === 'pull' ? 'pull' : 'issues', number: Number(number) },
      token,
    );
    if (item === 'missing') {
      await remember(database, key, url, { kind: 'missing' }, now, NEGATIVE_TTL_MS);
      return null;
    }
    await remember(database, key, url, { kind: 'card', card: item }, now, CARD_TTL_MS);
    return item;
  } catch (error) {
    // Said, and held off for a minute so a GitHub outage is not asked about on every render.
    log.warn('GitHub did not answer an unfurl', { workspaceId: context.workspaceId, error });
    await remember(database, key, url, { kind: 'missing' }, now, UNAVAILABLE_TTL_MS);
    return null;
  }
};
