/**
 * The bus modules meet on (`MODULES.md` §4, D-250 rule 4): a module says what happened, and whoever cares
 * has subscribed. Nobody listening is not an error, and a module never imports another to tell it.
 *
 * Not the socket `EventBus`, which fans frames out to connections: this one carries facts between the
 * modules of one process and never leaves it.
 *
 * **Delivery is at most once, after commit** (D-35, D-7): it is published by the caller once its write has
 * committed, a handler that throws is logged and cannot fail the publisher or its siblings, and nothing is
 * kept for a handler that was not there. An event whose loss would leave state wrong — a notification, an
 * index update — is therefore not carried by this alone: it is also a row written in the same transaction
 * and drained by a job (`MODULES.md` §4).
 */
import type { Logger } from './logging';

/** The name and payload of one kind of event. Made once, by the module that publishes it. */
export interface DomainEvent<Payload> {
  readonly type: string;
  /** Never read: it carries `Payload` to `publish` and `subscribe`, so the two cannot disagree. */
  readonly payload?: Payload;
}

export const domainEvent = <Payload>(type: string): DomainEvent<Payload> => ({ type });

type Handler<Payload> = (payload: Payload) => Promise<void> | void;

export interface DomainBus {
  /** Hands the payload to every subscriber and settles when they have; never rejects. */
  publish<Payload>(event: DomainEvent<Payload>, payload: Payload): Promise<void>;
  /** `module` names who listens, for the log when the handler fails. Returns the way to stop. */
  subscribe<Payload>(
    event: DomainEvent<Payload>,
    module: string,
    handler: Handler<Payload>,
  ): () => void;
}

interface Subscription {
  readonly module: string;
  readonly handler: Handler<never>;
}

export const inProcessDomainBus = (log: Logger): DomainBus => {
  const subscriptions = new Map<string, Subscription[]>();

  return {
    subscribe: (event, module, handler) => {
      const entry: Subscription = { module, handler };
      subscriptions.set(event.type, [...(subscriptions.get(event.type) ?? []), entry]);
      return (): void => {
        subscriptions.set(
          event.type,
          (subscriptions.get(event.type) ?? []).filter((other) => other !== entry),
        );
      };
    },

    publish: async <Payload>(event: DomainEvent<Payload>, payload: Payload): Promise<void> => {
      // The list as it is now: a handler that subscribes or stops meanwhile changes the next publish.
      const listening = subscriptions.get(event.type) ?? [];
      const settled = await Promise.allSettled(
        listening.map(async ({ handler }) => {
          await (handler as Handler<typeof payload>)(payload);
        }),
      );
      settled.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          log.error('a domain event handler failed', {
            event: event.type,
            module: listening[index]?.module,
            err: outcome.reason,
          });
        }
      });
    },
  };
};
