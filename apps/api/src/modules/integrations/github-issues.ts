/**
 * Creating a GitHub issue from a thread, as a write that can be recovered (D-246 §2, §4).
 *
 * - **As the person, and only as the person.** The issue is made with their own App user token, which reaches
 *   what both they and the App can; that token is refreshed under its row's lock (a refresh token is spent by
 *   the refresh that uses it) and forgotten when GitHub stops taking it. Nothing shared is read with it.
 * - **Everything is checked again at the moment of sending**, not when the form was opened: the person can still
 *   read the root and is still in its channel (`requireMessageById`, `requireChannelMember`), the installation is
 *   still the workspace's and not suspended, and the repository is still one GitHub lists for this person.
 * - **The words are the person's, as reviewed.** Title and body arrive as the person saw them; the one line added
 *   is a marker made from the request's own id, which the review showed. A conversation that is not public is
 *   copied only when the person said so.
 * - **One request, one issue.** The operation row — keyed by workspace, actor and the client's request id — is
 *   claimed before GitHub is asked, so a double click, a retry and a second tab are one operation. The same id
 *   with other content is a conflict. Only the request that claimed the row posts.
 * - **A lost answer is found, never repeated.** GitHub not answering leaves the operation `unknown`. Sent again,
 *   the request asks GitHub's reads — as the installation, which survives the person — for the issue that ends in
 *   the marker, and only ever posts if no operation was claimed at all. After fifteen minutes of reads that never
 *   show it, or twenty looks, it is refused as not created. A limit is waited out, as `Retry-After` says, by the
 *   client: nothing here sleeps or retries on its own.
 * - **Linking resolves nothing.** The issue is linked to the root and the thread is told; the question's state
 *   and every notification are untouched (D-12, D-134 §7).
 * - **Audited by identifier**: who, which repository, which issue — never a title or a body.
 */
import { createHash } from 'node:crypto';
import type { Executor } from '@purlay/db';
import {
  githubIssueMarker,
  GITHUB_REPOSITORIES_MAX,
  GITHUB_WORK_PER_THREAD_MAX,
  GitHubLink,
  type CreateGitHubIssueRequest,
  type GitHubIssueOutcome,
  type GitHubIssueRefusal,
  type GitHubRepository,
  type GitHubWorkLink,
  type LinkGitHubWorkRequest,
} from '@purlay/types';
import {
  requireChannelMember,
  requireMessageById,
  type VisibleMessage,
} from '../../platform/channels';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { appJwt } from '../../platform/github-app-key';
import { atomicallyOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import {
  GitHubRateLimited,
  GitHubUnauthorized,
  GitHubUnavailable,
  type IssueOnGitHub,
} from './github-app-api';
import { keepAuthorization, requireApp, sealedIn, type GitHubAppDependencies } from './github-app';
import { workLinkOf } from './github-work';
import { announce, tell } from './github-work-events';

export interface GitHubIssueDependencies extends GitHubAppDependencies {
  readonly bus: EventBus;
}

/** A user token about to lapse is refreshed, so it does not lapse between the check and the call. */
const TOKEN_SKEW_MS = 60_000;
/** An operation claimed and never answered this long ago is taken as not answered. */
const PENDING_STALE_MS = 2 * 60_000;
/** After this long of GitHub's reads never showing an issue, it was not made. */
const RECONCILE_GIVE_UP_MS = 15 * 60_000;
/** Looks at GitHub for one operation, as `github_operations_attempts_bounded` holds. */
const RECONCILE_ATTEMPTS_MAX = 20;
/** A page is a hundred repositories; five pages are `GITHUB_REPOSITORIES_MAX`. */
const REPOSITORY_PAGES_MAX = 5;

const unbase64 = (value: string): Uint8Array => Buffer.from(value, 'base64');

const authorizationRequired = (): AppError =>
  new AppError({
    code: 'GITHUB_AUTHORIZATION_REQUIRED',
    message: 'Let Purlay create issues as you first.',
  });

const notConnected = (): AppError =>
  new AppError({
    code: 'GITHUB_NOT_CONNECTED',
    message: 'This workspace has no GitHub installation in use.',
  });

const invalid = (field: string, message: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message,
    details: { fields: { [field]: message } },
  });

/** What GitHub's three ways of not helping are to the caller: a wait, an authorization gone, or no answer. */
const translated = async (
  dependencies: Pick<GitHubAppDependencies, 'database'>,
  userId: string,
  error: unknown,
): Promise<unknown> => {
  if (error instanceof GitHubRateLimited) {
    return new AppError(
      { code: 'RATE_LIMITED', message: 'GitHub asks to slow down. Try again shortly.' },
      { retryAfterSeconds: error.retryAfterSeconds },
    );
  }
  if (error instanceof GitHubUnauthorized) {
    // GitHub does not take the token any more: revoked, or the App removed. It is forgotten here too.
    await dependencies.database
      .deleteFrom('github_user_authorizations')
      .where('user_id', '=', userId)
      .execute();
    return authorizationRequired();
  }
  if (error instanceof GitHubUnavailable) {
    return new AppError({ code: 'GITHUB_UNAVAILABLE', message: 'GitHub did not answer.' });
  }
  return error;
};

/** Runs `work`, and says what became of it as the caller's own errors. */
const asCaller = async <T>(
  dependencies: Pick<GitHubAppDependencies, 'database'>,
  userId: string,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw await translated(dependencies, userId, error);
  }
};

interface Person {
  readonly token: string;
}

/** The person's own token, refreshed under its row's lock when it is about to lapse. */
const personOf = async (dependencies: GitHubAppDependencies, userId: string): Promise<Person> => {
  const app = requireApp(dependencies.app);
  const { database, clock, cipher, api } = dependencies;
  const current = (row: { readonly access_expires_at: Date | null }): boolean =>
    row.access_expires_at === null ||
    new Date(row.access_expires_at).getTime() > clock.now().getTime() + TOKEN_SKEW_MS;
  const open = async (row: {
    readonly id: string;
    readonly access_token_encrypted: string;
  }): Promise<Person> => ({
    token: await cipher.open(unbase64(row.access_token_encrypted), sealedIn('access', row.id)),
  });
  const row = await database
    .selectFrom('github_user_authorizations')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) throw authorizationRequired();
  if (current(row)) return await open(row);
  const refreshed = await atomicallyOn(database)(async (transaction) => {
    const locked = await transaction
      .selectFrom('github_user_authorizations')
      .selectAll()
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined) return 'gone' as const;
    // Somebody else refreshed while this waited for the lock: their token is the one.
    if (current(locked)) return await open(locked);
    const expired =
      locked.refresh_expires_at !== null &&
      new Date(locked.refresh_expires_at).getTime() <= clock.now().getTime();
    if (locked.refresh_token_encrypted === null || expired) return 'gone' as const;
    const spent = await cipher.open(
      unbase64(locked.refresh_token_encrypted),
      sealedIn('refresh', locked.id),
    );
    const tokens = await api.refresh(app, spent);
    if (tokens === 'refused') return 'gone' as const;
    await keepAuthorization(
      transaction,
      dependencies,
      userId,
      { id: Number(locked.github_user_id), login: locked.github_login },
      tokens,
    );
    return { token: tokens.accessToken };
  });
  if (refreshed === 'gone') {
    await database.deleteFrom('github_user_authorizations').where('user_id', '=', userId).execute();
    throw authorizationRequired();
  }
  return refreshed;
};

/** The workspace's installation, in use: there is one, and GitHub has not suspended it. */
const installationOf = async (
  database: Executor,
  workspaceId: string,
): Promise<{ readonly installationId: number }> => {
  const row = await database
    .selectFrom('github_app_installations')
    .select(['installation_id', 'suspended_at'])
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (row === undefined) throw notConnected();
  if (row.suspended_at !== null) throw notConnected();
  return { installationId: Number(row.installation_id) };
};

/** What the person may choose: the repositories both they and the App reach, as GitHub lists them now. */
const repositoriesOf = async (
  dependencies: GitHubAppDependencies,
  installationId: number,
  person: Person,
): Promise<readonly GitHubRepository[]> => {
  const found: GitHubRepository[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES_MAX; page++) {
    const batch = await dependencies.api.userRepositories(person.token, installationId, page);
    // An installation the person cannot reach on GitHub offers them nothing.
    if (batch === null) return [];
    found.push(
      ...batch.map((item) => ({ id: item.id, fullName: item.fullName, private: item.private })),
    );
    if (batch.length < 100) break;
  }
  return found.slice(0, GITHUB_REPOSITORIES_MAX);
};

/** `GET /api/workspaces/:workspaceId/github-repositories` — what this caller may choose. */
export const allowedRepositories = async (
  dependencies: GitHubAppDependencies,
  workspaceId: string,
  userId: string,
): Promise<readonly GitHubRepository[]> => {
  requireApp(dependencies.app);
  const installation = await installationOf(dependencies.database, workspaceId);
  return await asCaller(dependencies, userId, async () => {
    const person = await personOf(dependencies, userId);
    return await repositoriesOf(dependencies, installation.installationId, person);
  });
};

interface Operation {
  readonly id: string;
  readonly workspace_id: string;
  readonly root_id: string;
  readonly content_digest: string;
  readonly repository_id: string;
  readonly repository_full_name: string;
  readonly marker: string;
  readonly status: string;
  readonly reason: string | null;
  readonly issue_number: number | null;
  readonly attempts: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const digestOf = (input: CreateGitHubIssueRequest): string =>
  createHash('sha256')
    .update(JSON.stringify([input.repositoryId, input.title, input.body, input.copyPrivateText]))
    .digest('hex');

const operationOf = async (
  database: Executor,
  workspaceId: string,
  actorId: string,
  clientRequestId: string,
): Promise<Operation | undefined> =>
  await database
    .selectFrom('github_operations')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('actor_id', '=', actorId)
    .where('client_request_id', '=', clientRequestId)
    .executeTakeFirst();

const REFUSALS: ReadonlySet<string> = new Set<GitHubIssueRefusal>([
  'no-access',
  'issues-disabled',
  'invalid',
  'not-created',
]);

const refusedOutcome = (reason: string | null): GitHubIssueOutcome => {
  if (reason === null || !REFUSALS.has(reason)) {
    throw new Error('a refused operation holds a reason the contract does not name');
  }
  return { status: 'refused', reason: reason as GitHubIssueRefusal };
};

/** An operation's end, written in a statement of its own: it stands whatever is answered. */
const settle = async (
  dependencies: Pick<GitHubAppDependencies, 'database' | 'clock'>,
  operation: Pick<Operation, 'id'>,
  change:
    | { readonly status: 'unknown'; readonly attempts?: number }
    | { readonly status: 'refused'; readonly reason: GitHubIssueRefusal },
): Promise<void> => {
  await dependencies.database
    .updateTable('github_operations')
    .set({
      status: change.status,
      reason: change.status === 'refused' ? change.reason : null,
      ...(change.status === 'unknown' && change.attempts !== undefined
        ? { attempts: change.attempts }
        : {}),
      updated_at: dependencies.clock.now(),
    })
    .where('id', '=', operation.id)
    .execute();
};

const dropped = async (database: Executor, operation: Pick<Operation, 'id'>): Promise<void> => {
  await database.deleteFrom('github_operations').where('id', '=', operation.id).execute();
};

/**
 * The issue exists: the operation is `created`, the root is linked, the trail has it and the thread is told —
 * all or none, in one transaction; the thread is told after it commits.
 */
export const finishOperation = async (
  dependencies: Pick<GitHubIssueDependencies, 'database' | 'clock' | 'bus' | 'log'>,
  channelId: string,
  actorId: string,
  operation: Operation,
  issue: IssueOnGitHub,
): Promise<GitHubIssueOutcome> => {
  const { database, clock } = dependencies;
  const done = await atomicallyOn(database)(async (transaction) => {
    const now = clock.now();
    await transaction
      .updateTable('github_operations')
      .set({ status: 'created', reason: null, issue_number: issue.number, updated_at: now })
      .where('id', '=', operation.id)
      .execute();
    const link = await transaction
      .insertInto('github_links')
      .values({
        id: crypto.randomUUID(),
        workspace_id: operation.workspace_id,
        channel_id: channelId,
        root_id: operation.root_id,
        repository_id: operation.repository_id,
        repository_full_name: operation.repository_full_name,
        kind: 'issue',
        number: issue.number,
        title: issue.title.slice(0, 256),
        state: issue.state,
        state_at: issue.updatedAt,
        origin: 'created',
        created_by: actorId,
        created_at: now,
      })
      // A second finish of one operation — a reconciliation racing its own answer, or the delivery that saw the
      // issue first — links once.
      .onConflict((conflict) =>
        conflict.columns(['root_id', 'repository_id', 'kind', 'number']).doUpdateSet({
          title: issue.title.slice(0, 256),
        }),
      )
      .returning(['id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, clock, {
      workspaceId: operation.workspace_id,
      actorUserId: actorId,
      action: 'integration.issue_created',
      targetType: 'message',
      targetId: operation.root_id,
      metadata: {
        repository: operation.repository_full_name,
        issue: String(issue.number),
        channelId,
      },
    });
    return {
      link: workLinkOf(link),
      notice: await announce(transaction, channelId, operation.root_id),
    };
  });
  await tell(dependencies, [done.notice]);
  return { status: 'created', link: done.link };
};

/**
 * The installation's own token, minted as the App. GitHub refusing it is the App's trouble — its key, or the
 * installation — and never the person's token, which stays: so it is said as GitHub not answering.
 */
const installationTokenOf = async (
  dependencies: GitHubAppDependencies,
  installationId: number,
): Promise<string> => {
  const app = requireApp(dependencies.app);
  try {
    return await dependencies.api.installationToken(
      appJwt(app.clientId, app.privateKey, dependencies.clock.now()),
      installationId,
    );
  } catch (error) {
    if (error instanceof GitHubUnauthorized) {
      throw new GitHubUnavailable('GitHub did not take the App’s own token');
    }
    throw error;
  }
};

/** GitHub's reads, as the installation: the issue that ends in the operation's marker, if there is one. */
const sighted = async (
  dependencies: GitHubAppDependencies,
  operation: Operation,
): Promise<IssueOnGitHub | undefined> => {
  const installation = await installationOf(dependencies.database, operation.workspace_id);
  const token = await installationTokenOf(dependencies, installation.installationId);
  // From a minute before the operation was claimed, a clock's slack, to now.
  const since = new Date(new Date(operation.created_at).getTime() - 60_000);
  const issues = await dependencies.api.issuesSince(token, operation.repository_full_name, since);
  return issues.find((issue) => issue.body.trimEnd().endsWith(operation.marker));
};

/**
 * What became of an `unknown` operation, found by GitHub's reads and never by posting again: the issue (created),
 * nothing yet (still unknown), or — past fifteen minutes or twenty looks — nothing ever (refused as not created).
 */
const reconcile = async (
  dependencies: GitHubIssueDependencies,
  target: VisibleMessage,
  actorId: string,
  operation: Operation,
): Promise<GitHubIssueOutcome> => {
  const { clock } = dependencies;
  let issue: IssueOnGitHub | undefined;
  try {
    issue = await sighted(dependencies, operation);
  } catch (error) {
    // Not heard from GitHub: still not known, and not a look at it.
    if (error instanceof GitHubUnavailable) return { status: 'unknown' };
    throw await translated(dependencies, actorId, error);
  }
  if (issue !== undefined)
    return await finishOperation(dependencies, target.context.channelId, actorId, operation, issue);
  const attempts = operation.attempts + 1;
  const late =
    clock.now().getTime() - new Date(operation.created_at).getTime() >= RECONCILE_GIVE_UP_MS;
  if (late || attempts >= RECONCILE_ATTEMPTS_MAX) {
    await settle(dependencies, operation, { status: 'refused', reason: 'not-created' });
    return { status: 'refused', reason: 'not-created' };
  }
  await settle(dependencies, operation, { status: 'unknown', attempts });
  return { status: 'unknown' };
};

/** A request this person already made, answered as it was; never asks GitHub whether they may. */
const replay = async (
  dependencies: GitHubIssueDependencies,
  target: VisibleMessage,
  actorId: string,
  operation: Operation,
  digest: string,
): Promise<GitHubIssueOutcome> => {
  if (operation.content_digest !== digest || operation.root_id !== target.messageId) {
    throw new AppError({
      code: 'GITHUB_REQUEST_CONFLICT',
      message: 'That request id was used for something else. Start again.',
    });
  }
  if (operation.status === 'refused') return refusedOutcome(operation.reason);
  if (operation.status === 'created') {
    const link = await dependencies.database
      .selectFrom('github_links')
      .select(['id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
      .where('root_id', '=', operation.root_id)
      .where('repository_id', '=', operation.repository_id)
      .where('kind', '=', 'issue')
      .where('number', '=', operation.issue_number ?? 0)
      .executeTakeFirstOrThrow();
    return { status: 'created', link: workLinkOf(link) };
  }
  const stale =
    dependencies.clock.now().getTime() - new Date(operation.updated_at).getTime() >=
    PENDING_STALE_MS;
  if (operation.status === 'pending' && !stale) return { status: 'pending' };
  return await reconcile(dependencies, target, actorId, operation);
};

/**
 * `POST /api/messages/:messageId/github-issue`. Everything the person reviewed, checked again as it is sent;
 * the outcome is one of the four the contract names, or an error for what the person must put right first.
 */
export const createIssue = async (
  dependencies: GitHubIssueDependencies,
  userId: string,
  rootId: string,
  input: CreateGitHubIssueRequest,
): Promise<GitHubIssueOutcome> => {
  requireApp(dependencies.app);
  const { database, clock } = dependencies;
  const target = await requireMessageById(database, userId, rootId);
  await requireChannelMember(
    database,
    target.context,
    'Join the channel to create an issue from it.',
  );
  if (target.parentId !== null) {
    throw invalid('messageId', 'Only the message that started a thread can become an issue.');
  }
  if (target.context.channelType !== 'public' && !input.copyPrivateText) {
    throw invalid(
      'copyPrivateText',
      'Say that the words of this conversation may be copied to GitHub.',
    );
  }
  const workspaceId = target.context.workspaceId;
  const digest = digestOf(input);
  const known = await operationOf(database, workspaceId, userId, input.clientRequestId);
  if (known !== undefined) return await replay(dependencies, target, userId, known, digest);

  const installation = await installationOf(database, workspaceId);
  const marker = githubIssueMarker(input.clientRequestId);
  const sent = await asCaller(dependencies, userId, async () => {
    const person = await personOf(dependencies, userId);
    // Still listed by GitHub for this person now, not only when the form was opened.
    const repositories = await repositoriesOf(dependencies, installation.installationId, person);
    const repository = repositories.find((candidate) => candidate.id === input.repositoryId);
    if (repository === undefined) return { refused: 'no-access' as const };
    const now = clock.now();
    const claimed = await database
      .insertInto('github_operations')
      .values({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        actor_id: userId,
        client_request_id: input.clientRequestId,
        content_digest: digest,
        root_id: rootId,
        repository_id: repository.id,
        repository_full_name: repository.fullName,
        marker,
        status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
    return { person, repository, claimed };
  });
  if ('refused' in sent) return { status: 'refused', reason: sent.refused };
  // Another click claimed it between the look above and the insert: theirs is the one that posts.
  if (sent.claimed === undefined) {
    const raced = await operationOf(database, workspaceId, userId, input.clientRequestId);
    if (raced === undefined) throw new Error('an operation claimed twice is not there');
    return await replay(dependencies, target, userId, raced, digest);
  }
  const operation = sent.claimed;
  const text = input.body === '' ? marker : `${input.body}\n\n${marker}`;
  let made: Awaited<ReturnType<GitHubAppDependencies['api']['createIssue']>>;
  try {
    made = await dependencies.api.createIssue(sent.person.token, operation.repository_full_name, {
      title: input.title,
      body: text,
    });
  } catch (error) {
    if (error instanceof GitHubUnavailable) {
      // Whether it was made is not known: never posted again, found by its marker.
      await settle(dependencies, operation, { status: 'unknown', attempts: 0 });
      return { status: 'unknown' };
    }
    // Nothing was made, or the person's access is gone: the claim is given back so a retry may be made.
    await dropped(database, operation);
    throw await translated(dependencies, userId, error);
  }
  if ('refused' in made) {
    await settle(dependencies, operation, { status: 'refused', reason: made.refused });
    return { status: 'refused', reason: made.refused };
  }
  return await finishOperation(dependencies, target.context.channelId, userId, operation, made);
};

/** The contract's own pattern for an address, so what is accepted and what is taken apart cannot differ. */
const WORK_ADDRESS = new RegExp(GitHubLink.pattern ?? '^$');

/**
 * `POST /api/messages/:messageId/github-link` — an issue or pull request that exists, pointed at from a root.
 *
 * Read with the **installation's** token, never the person's: what a thread shows of it is the workspace's, the
 * same for everybody, and survives the person. The person's own access still decides whether they may point at
 * it — the repository must be one GitHub lists for them inside the installation — so a title cannot be had by
 * naming a private repository one cannot see; the answer is the same whether it does not exist or may not be
 * reached. Nothing is written to GitHub and nothing is resolved.
 */
export const linkWork = async (
  dependencies: GitHubIssueDependencies,
  userId: string,
  rootId: string,
  input: LinkGitHubWorkRequest,
): Promise<{ readonly link: GitHubWorkLink; readonly created: boolean }> => {
  requireApp(dependencies.app);
  const { database, clock } = dependencies;
  const target = await requireMessageById(database, userId, rootId);
  await requireChannelMember(
    database,
    target.context,
    'Join the channel to link GitHub work to it.',
  );
  if (target.parentId !== null) {
    throw invalid('messageId', 'Only the message that started a thread can point at GitHub work.');
  }
  const parts = WORK_ADDRESS.exec(input.url);
  if (parts === null) throw invalid('url', 'That is not an issue or pull request address.');
  const [, owner = '', name = '', , number = ''] = parts;
  const workspaceId = target.context.workspaceId;
  const installation = await installationOf(database, workspaceId);
  const unreachable = invalid(
    'url',
    'GitHub has no such issue or pull request that you and the App can both reach.',
  );
  const found = await asCaller(dependencies, userId, async () => {
    const person = await personOf(dependencies, userId);
    const repositories = await repositoriesOf(dependencies, installation.installationId, person);
    const repository = repositories.find(
      (candidate) => candidate.fullName.toLowerCase() === `${owner}/${name}`.toLowerCase(),
    );
    if (repository === undefined) return undefined;
    const token = await installationTokenOf(dependencies, installation.installationId);
    const work = await dependencies.api.item(token, repository.fullName, Number(number));
    return work === 'missing' ? undefined : { repository, work };
  });
  if (found === undefined) throw unreachable;
  const { repository, work } = found;
  const made = await atomicallyOn(database)(async (transaction) => {
    const existing = await transaction
      .selectFrom('github_links')
      .select(['id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
      .where('root_id', '=', rootId)
      .orderBy('created_at')
      .execute();
    const same = existing.find(
      (row) =>
        row.kind === work.kind &&
        row.number === work.number &&
        row.repository_full_name === repository.fullName,
    );
    if (same !== undefined) return { link: workLinkOf(same), created: false, notice: undefined };
    if (existing.length >= GITHUB_WORK_PER_THREAD_MAX) {
      throw invalid('url', 'This thread already points at as much GitHub work as it can.');
    }
    const now = clock.now();
    const row = await transaction
      .insertInto('github_links')
      .values({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        channel_id: target.context.channelId,
        root_id: rootId,
        repository_id: repository.id,
        repository_full_name: repository.fullName,
        kind: work.kind,
        number: work.number,
        title: work.title.slice(0, 256),
        state: work.state,
        state_at: work.updatedAt,
        origin: 'linked',
        created_by: userId,
        created_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning(['id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
      .executeTakeFirst();
    // Linked by another click in the same instant: theirs stands, and this is the same answer.
    if (row === undefined) {
      const raced = await transaction
        .selectFrom('github_links')
        .select(['id', 'repository_full_name', 'kind', 'number', 'title', 'state', 'origin'])
        .where('root_id', '=', rootId)
        .where('repository_id', '=', String(repository.id))
        .where('kind', '=', work.kind)
        .where('number', '=', work.number)
        .executeTakeFirstOrThrow();
      return { link: workLinkOf(raced), created: false, notice: undefined };
    }
    await recordAudit(transaction, clock, {
      workspaceId,
      actorUserId: userId,
      action: 'integration.work_linked',
      targetType: 'message',
      targetId: rootId,
      metadata: {
        repository: repository.fullName,
        number: String(work.number),
        channelId: target.context.channelId,
      },
    });
    return {
      link: workLinkOf(row),
      created: true,
      notice: await announce(transaction, target.context.channelId, rootId),
    };
  });
  if (made.notice !== undefined) await tell(dependencies, [made.notice]);
  return { link: made.link, created: made.created };
};
