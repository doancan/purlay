/**
 * `POST /api/webhooks/github/:feedId` (#79, D-134 §4): GitHub's delivery to a repository's feed.
 * Nobody is signed in, so the edge has held the body to its length and type (`edge.ts`). Here, before
 * a byte is read: the address spends its own bucket, the feed must be there, and this node reads a
 * few at a time, each within a deadline — so a stranger can neither spend every feed's deliveries nor
 * hold the reads open. The feed's own bucket is charged once its signature holds, in the service.
 */
import { AppError } from '../../platform/errors';
import {
  receiveDelivery,
  requireFeed,
  type Outcome,
  type WebhookDependencies,
} from '../../modules/integrations/webhook';

/** Deliveries read at once on this node: each is up to a mebibyte held while it is checked. */
export const DELIVERIES_AT_ONCE = 8;

/** How long a delivery's body may take to arrive: GitHub sends it at once; a trickle is not GitHub. */
const DELIVERY_READ_MS = 10_000;

export interface WebhookRouteDependencies extends WebhookDependencies {
  /** Whether this address may knock once more: its own bucket, before anything is looked up. */
  readonly mayKnock: (address: string) => Promise<boolean>;
  /** This node's count of deliveries being read: the gate, held by the app. */
  readonly inFlight: { count: number };
  /** Settles when a read has taken too long; the clock's, so a test decides when. */
  readonly deadline: (ms: number) => Promise<void>;
}

const busy = (): AppError =>
  new AppError({ code: 'RATE_LIMITED', message: 'Too many deliveries. Slow down.' });

/** The body, or a refusal once the deadline passes first. */
const readWithin = async (request: Request, deadline: Promise<void>): Promise<Uint8Array> => {
  const late = Symbol('late');
  const read = await Promise.race([request.arrayBuffer(), deadline.then(() => late)]);
  if (read === late) throw busy();
  return new Uint8Array(read as ArrayBuffer);
};

export const receiveWebhook = async (
  dependencies: WebhookRouteDependencies,
  request: Request,
  feedId: string,
  address: string,
): Promise<Outcome> => {
  const { mayKnock, inFlight, log, deadline } = dependencies;
  if (!(await mayKnock(address))) {
    log.warn('github delivery', { feedId, outcome: 'knocked_too_often' });
    throw busy();
  }
  await requireFeed(dependencies.database, feedId);
  if (inFlight.count >= DELIVERIES_AT_ONCE) {
    log.warn('github delivery', { feedId, outcome: 'node_busy' });
    throw busy();
  }
  inFlight.count += 1;
  try {
    const body = await readWithin(request, deadline(DELIVERY_READ_MS)).catch((error: unknown) => {
      if (error instanceof AppError)
        log.warn('github delivery', { feedId, outcome: 'read_too_slow' });
      throw error;
    });
    return await receiveDelivery(dependencies, {
      feedId,
      signature: request.headers.get('x-hub-signature-256'),
      event: request.headers.get('x-github-event'),
      deliveryId: request.headers.get('x-github-delivery'),
      body,
    });
  } finally {
    inFlight.count -= 1;
  }
};
