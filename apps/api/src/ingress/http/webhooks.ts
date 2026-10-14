/**
 * `POST /api/webhooks/github/:feedId` (#79, D-134 §4): GitHub's delivery to a repository's feed.
 * Nobody is signed in, so the edge has held the body to its length and type (`edge.ts`); here, before
 * a byte is read, every address shares one bucket and this node reads a few at a time — the feed's
 * own bucket is charged only once its signature holds, in the service. Then one service call.
 */
import { AppError } from '../../platform/errors';
import {
  receiveDelivery,
  type Outcome,
  type WebhookDependencies,
} from '../../modules/integrations/webhook';

/** Deliveries read at once on this node: each is up to a mebibyte held while it is checked. */
export const DELIVERIES_AT_ONCE = 8;

export interface WebhookRouteDependencies extends WebhookDependencies {
  /** Whether one more delivery may be looked at now, from anybody: before the signature. */
  readonly mayKnock: () => Promise<boolean>;
  /** This node's count of deliveries being read: the gate, held by the app. */
  readonly inFlight: { count: number };
}

const busy = (): AppError =>
  new AppError({ code: 'RATE_LIMITED', message: 'Too many deliveries. Slow down.' });

export const receiveWebhook = async (
  dependencies: WebhookRouteDependencies,
  request: Request,
  feedId: string,
): Promise<Outcome> => {
  const { mayKnock, inFlight } = dependencies;
  if (!(await mayKnock())) throw busy();
  if (inFlight.count >= DELIVERIES_AT_ONCE) throw busy();
  inFlight.count += 1;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
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
