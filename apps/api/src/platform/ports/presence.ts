/**
 * How the socket tells who is online without naming the module whose news that is (`MODULES.md` §4, D-136, D-352): the core
 * counts each person's sockets and tries a failed telling again (`realtime/online.ts`), and the module that owns the event
 * `PRESENCE` decides who hears a change and what (chat's `presence/presence.ts`). A process where no module announces
 * presence counts nobody.
 */
import type { PresenceChange } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../clock';
import type { EventBus } from '../events';
import type { Logger } from '../logging';

interface PresenceAnnouncerDependencies {
  readonly database: Executor;
  /** The node's bus the change is published on, to each listener's own topic. */
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Tells one change; a rejection is the core's to try again, as many times as `online.ts` allows. */
export type PresenceAnnouncer = (
  dependencies: PresenceAnnouncerDependencies,
  change: PresenceChange,
) => Promise<void>;
