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

export type AppOutcome = GitHubAppDeliveryAnswer['outcome'];

export interface AppDeliveryDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
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
  if (event === 'github_app_authorization') {
    if (!Value.Check(AuthorizationEvent, body)) {
      throw invalid('body', 'is not an authorization event');
    }
    return body.action === 'revoked' ? { kind: 'revoked', githubUserId: body.sender.id } : null;
  }
  return null;
};

/** A change applied, in the transaction that records its delivery. */
const apply = async (transaction: Executor, clock: Clock, change: Change): Promise<void> => {
  switch (change.kind) {
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
      return;
    }
    case 'suspended':
      await transaction
        .updateTable('github_app_installations')
        .set({ suspended_at: change.suspended ? clock.now() : null })
        .where('installation_id', '=', String(change.installationId))
        .execute();
      return;
    case 'revoked':
      await transaction
        .deleteFrom('github_user_authorizations')
        .where('github_user_id', '=', String(change.githubUserId))
        .execute();
      return;
  }
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
  const outcome = await atomicallyOn(database)(async (transaction): Promise<AppOutcome> => {
    // Either key taken is the same delivery: its id again, or its body under another id.
    const recorded = await transaction
      .insertInto('github_app_deliveries')
      .values({ delivery_id: deliveryId, body_digest: bodyDigest, received_at: clock.now() })
      .onConflict((conflict) => conflict.doNothing())
      .returning('delivery_id')
      .executeTakeFirst();
    if (recorded === undefined) return 'duplicate';
    if (change === null) return 'ignored';
    await apply(transaction, clock, change);
    return 'applied';
  });
  log.info('github app delivery', { ...line, outcome });
  return outcome;
};
