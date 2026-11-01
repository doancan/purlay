/**
 * A delivery to the GitHub App's one address (D-246 §1, §5).
 *
 * Nobody is signed in: the App's webhook secret is the only credential, and the signature over the bytes as
 * sent is checked in constant time before a byte of them is believed (`signedBy`, as a feed's, D-134 §4). A
 * delivery is applied once: its id and its body's digest are recorded in the transaction that applies it, and
 * either again — the id redelivered, or the same signed body under an id made up (D-231 §1) — applies nothing.
 *
 * What it applies is what GitHub tells the App about access, so access ends when GitHub says it does:
 *
 * - `installation` `deleted`: every workspace that connected that installation lets it go — its links stay.
 * - `installation` `suspend` and `unsuspend`: kept, and said; a suspended installation is used for nothing.
 * - `github_app_authorization` `revoked`: the person revoked the App on GitHub; their tokens are forgotten.
 *
 * Anything else GitHub sends the App is received and ignored. Every delivery is one log line — delivery, event
 * and outcome, never the body.
 */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import type { GitHubAppDeliveryAnswer } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import type { GitHubAppSettings } from '../setup/settings';
import { signedBy } from './webhook';
import { finishOperation } from './github-issues';
import { applyItemEvent, tell, type ItemEvent, type ThreadNotice } from './github-work-events';
import type { EventBus } from '../../platform/events';

export type AppOutcome = GitHubAppDeliveryAnswer['outcome'];

export interface AppDeliveryDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
  readonly app: GitHubAppSettings | undefined;
}

export interface AppDelivery {
  /** `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`, as sent; null when absent. */
  readonly signature: string | null;
  readonly event: string | null;
  readonly deliveryId: string | null;
  readonly body: Uint8Array;
}

const DELIVERY_ID = /^[0-9A-Za-z-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

const InstallationEvent = Type.Object({
  action: Type.String({ maxLength: 64 }),
  installation: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
});

/** What every event about an item names: the installation it came through and the repository. */
const Where = {
  installation: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
  repository: Type.Object({
    id: Type.Integer({ minimum: 1 }),
    full_name: Type.String({ minLength: 3, maxLength: 140 }),
  }),
};

const IssueEvent = Type.Object({
  action: Type.String({ maxLength: 64 }),
  ...Where,
  issue: Type.Object({
    number: Type.Integer({ minimum: 1 }),
    title: Type.String(),
    body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
    updated_at: Type.String({ format: 'date-time' }),
    pull_request: Type.Optional(Type.Unknown()),
  }),
});

const PullEvent = Type.Object({
  action: Type.String({ maxLength: 64 }),
  ...Where,
  number: Type.Integer({ minimum: 1 }),
  pull_request: Type.Object({
    title: Type.String(),
    state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
    merged: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    updated_at: Type.String({ format: 'date-time' }),
  }),
});

/** The actions that change what a thread shows of an item: its words, or open, closed and merged. */
const SHOWN_ISSUE_ACTIONS: ReadonlySet<string> = new Set(['edited', 'closed', 'reopened']);
const SHOWN_PULL_ACTIONS: ReadonlySet<string> = new Set(['edited', 'closed', 'reopened']);

const AuthorizationEvent = Type.Object({
  action: Type.String({ maxLength: 64 }),
  sender: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
});

/** Whether there is an App to deliver to, asked before the body is read: without one the address is not there. */
export const requireAppAddress = (app: GitHubAppSettings | undefined): GitHubAppSettings => {
  if (app === undefined) {
    throw new AppError({
      code: 'ROUTE_NOT_FOUND',
      message: 'There is no GitHub App on this server.',
    });
  }
  return app;
};

const invalid = (field: string, why: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The delivery is not one GitHub documents.',
    details: { fields: { [field]: why } },
  });

/** What a delivery changes here, read from its body before anything is written; null is nothing. */
type Change =
  | { readonly kind: 'item'; readonly item: ItemEvent }
  | {
      /** An issue just made: its body may end in the marker of an operation whose answer was lost. */
      readonly kind: 'opened';
      readonly item: ItemEvent;
      readonly repositoryName: string;
      readonly body: string;
    }
  | { readonly kind: 'removed'; readonly installationId: number }
  | { readonly kind: 'suspended'; readonly installationId: number; readonly suspended: boolean }
  | { readonly kind: 'revoked'; readonly githubUserId: number };

/** The change an event asks for; a body that is not the event it names is refused, before it is recorded. */
const changeOf = (event: string, body: unknown): Change | null => {
  if (event === 'installation') {
    if (!Value.Check(InstallationEvent, body))
      throw invalid('body', 'is not an installation event');
    const installationId = body.installation.id;
    if (body.action === 'deleted') return { kind: 'removed', installationId };
    if (body.action === 'suspend' || body.action === 'unsuspend') {
      return { kind: 'suspended', installationId, suspended: body.action === 'suspend' };
    }
    return null;
  }
  if (event === 'issues') {
    if (!Value.Check(IssueEvent, body)) throw invalid('body', 'is not an issues event');
    // A pull request is an issue to this event too, and is told by its own.
    if (body.issue.pull_request !== undefined) return null;
    const item: ItemEvent = {
      installationId: body.installation.id,
      repositoryId: body.repository.id,
      kind: 'issue',
      number: body.issue.number,
      title: body.issue.title,
      state: body.issue.state,
      updatedAt: new Date(body.issue.updated_at),
    };
    if (body.action === 'opened') {
      return {
        kind: 'opened',
        item,
        repositoryName: body.repository.full_name,
        body: body.issue.body ?? '',
      };
    }
    return SHOWN_ISSUE_ACTIONS.has(body.action) ? { kind: 'item', item } : null;
  }
  if (event === 'pull_request') {
    if (!Value.Check(PullEvent, body)) throw invalid('body', 'is not a pull request event');
    if (!SHOWN_PULL_ACTIONS.has(body.action)) return null;
    return {
      kind: 'item',
      item: {
        installationId: body.installation.id,
        repositoryId: body.repository.id,
        kind: 'pull',
        number: body.number,
        title: body.pull_request.title,
        // Closed is merged only when GitHub says it was; null while it has not worked it out is closed.
        state:
          body.pull_request.state === 'open'
            ? 'open'
            : body.pull_request.merged === true
              ? 'merged'
              : 'closed',
        updatedAt: new Date(body.pull_request.updated_at),
      },
    };
  }
  if (event === 'github_app_authorization') {
    if (!Value.Check(AuthorizationEvent, body)) {
      throw invalid('body', 'is not an authorization event');
    }
    return body.action === 'revoked' ? { kind: 'revoked', githubUserId: body.sender.id } : null;
  }
  return null;
};

/** A change applied, in the transaction that records its delivery; the threads that now have something to show. */
const apply = async (
  transaction: Executor,
  clock: Clock,
  change: Change,
): Promise<readonly ThreadNotice[]> => {
  switch (change.kind) {
    case 'item':
      return await applyItemEvent(transaction, change.item);
    case 'opened':
      // Seen, and nothing yet to change: a link to it exists only if somebody made it from a thread.
      return await applyItemEvent(transaction, change.item);
    case 'removed': {
      const removed = await transaction
        .deleteFrom('github_app_installations')
        .where('installation_id', '=', String(change.installationId))
        .returning(['id', 'workspace_id', 'account_login'])
        .execute();
      // GitHub let it go, not a person: the trail says so with nobody as the actor.
      for (const row of removed) {
        await recordAudit(transaction, clock, {
          workspaceId: row.workspace_id,
          actorUserId: null,
          action: 'integration.app_disconnected',
          targetType: 'integration',
          targetId: row.id,
          metadata: { account: row.account_login },
        });
      }
      return [];
    }
    case 'suspended':
      await transaction
        .updateTable('github_app_installations')
        .set({ suspended_at: change.suspended ? clock.now() : null })
        .where('installation_id', '=', String(change.installationId))
        .execute();
      return [];
    case 'revoked':
      await transaction
        .deleteFrom('github_user_authorizations')
        .where('github_user_id', '=', String(change.githubUserId))
        .execute();
      return [];
  }
};

/**
 * An issue that has just been made, seen before the person's own answer came back: if its body ends in the
 * marker of an operation still waiting on GitHub's answer, that operation is what it was (D-246 §4). After the
 * delivery committed, so that nothing is told of a delivery that did not stay; a delivery lost between the two
 * costs nothing, since sending the request again finds the issue by its marker.
 */
const completeByMarker = async (
  dependencies: AppDeliveryDependencies,
  change: Extract<Change, { kind: 'opened' }>,
): Promise<void> => {
  const marker = /<!-- purlay:[0-9a-f-]{36} -->\s*$/.exec(change.body)?.[0].trim();
  if (marker === undefined) return;
  const operation = await dependencies.database
    .selectFrom('github_operations')
    .selectAll()
    .where('marker', '=', marker)
    .where('repository_id', '=', String(change.item.repositoryId))
    .where('status', 'in', ['pending', 'unknown'])
    .executeTakeFirst();
  if (operation?.actor_id == null) return;
  const root = await dependencies.database
    .selectFrom('messages')
    .select('channel_id')
    .where('id', '=', operation.root_id)
    .executeTakeFirst();
  if (root === undefined) return;
  await finishOperation(dependencies, root.channel_id, operation.actor_id, operation, {
    number: change.item.number,
    title: change.item.title,
    body: change.body,
    state: change.item.state === 'open' ? 'open' : 'closed',
    updatedAt: change.item.updatedAt,
  });
};

export const receiveAppDelivery = async (
  dependencies: AppDeliveryDependencies,
  delivery: AppDelivery,
): Promise<AppOutcome> => {
  const { database, clock, log } = dependencies;
  const app = requireAppAddress(dependencies.app);
  if (!signedBy(app.webhookSecret, delivery.body, delivery.signature)) {
    throw new AppError({
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'The signature does not match the App’s webhook secret.',
    });
  }
  const { event, deliveryId } = delivery;
  if (
    event === null ||
    !EVENT_NAME.test(event) ||
    deliveryId === null ||
    !DELIVERY_ID.test(deliveryId)
  ) {
    throw invalid('headers', 'X-GitHub-Event and X-GitHub-Delivery are required');
  }
  const line = { deliveryId, event };
  if (event === 'ping') {
    log.info('github app delivery', { ...line, outcome: 'pinged' });
    return 'pinged';
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(delivery.body));
  } catch {
    log.warn('github app delivery', { ...line, outcome: 'payload_invalid' });
    throw invalid('body', 'is not JSON');
  }
  const change = changeOf(event, body);
  const bodyDigest = createHash('sha256').update(delivery.body).digest('hex');
  const done = await atomicallyOn(database)(
    async (
      transaction,
    ): Promise<{ readonly outcome: AppOutcome; readonly notices: readonly ThreadNotice[] }> => {
      // Either key taken is the same delivery: its id again, or its body under another id.
      const recorded = await transaction
        .insertInto('github_app_deliveries')
        .values({ delivery_id: deliveryId, body_digest: bodyDigest, received_at: clock.now() })
        .onConflict((conflict) => conflict.doNothing())
        .returning('delivery_id')
        .executeTakeFirst();
      if (recorded === undefined) return { outcome: 'duplicate', notices: [] };
      if (change === null) return { outcome: 'ignored', notices: [] };
      return { outcome: 'applied', notices: await apply(transaction, clock, change) };
    },
  );
  // Told once what was applied has committed, and never as a notification: a state shown, nothing more.
  await tell(dependencies, done.notices);
  if (done.outcome === 'applied' && change?.kind === 'opened') {
    await completeByMarker(dependencies, change);
  }
  log.info('github app delivery', { ...line, outcome: done.outcome });
  return done.outcome;
};
