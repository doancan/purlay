/**
 * The notification sink and the fact publisher of each module, made from what the application knows once: the routes of a module
 * (`createApp`) and its workers and consumers (`index.ts`) are handed the same sink and the same publishing context, so a notice
 * or a fact is written by the same rules from either (D-283 §2, D-286). Kept at the root with the composition, which is what it reads.
 */
import type { Composition } from './composition';
import { notificationSink } from './modules/inbox/sink';
import type { PushSender } from './modules/push/sender';
import type { Clock } from './platform/clock';
import type { EventBus } from './platform/events';
import type { Logger } from './platform/logging';
import type { ServerMetrics } from './platform/metrics';
import { factRoutingOf } from './platform/outbox';
import type { SharedFactContext } from './platform/ports/fact-publisher';
import { moduleSeams, type ModuleSeams } from './platform/ports/module-seams';
import type { NotificationSink } from './platform/ports/notification-sink';
import { withoutStopped } from './platform/suspended-modules';

interface SeamInputs {
  readonly composition: Composition;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly metrics: Pick<
    ServerMetrics,
    'outboxDropped' | 'outboxRefused' | 'inboxEntries' | 'inboxCollapsed'
  >;
  readonly outboxPendingMax: number;
  readonly push?: PushSender;
}

/** Who consumes what over the whole build, and which of it this process runs: what a publish writes a row for (D-288). */
export const factContextOf = ({
  composition,
  clock,
  metrics,
  outboxPendingMax,
}: SeamInputs): SharedFactContext => ({
  clock,
  routing: withoutStopped(
    factRoutingOf(
      composition.bundled.map((module) => module.manifest),
      composition.modules.map((module) => module.manifest),
    ),
    composition.suspension.current,
  ),
  dropped: metrics.outboxDropped,
  refused: metrics.outboxRefused,
  pendingMax: outboxPendingMax,
  effective: composition.effectiveModules,
});

/** The core's sink as the module `module` is handed it: every notice it writes is that module's. */
export const sinkOfModule = (module: string, inputs: SeamInputs): NotificationSink =>
  notificationSink({
    module,
    clock: inputs.clock,
    kinds: inputs.composition.noticeOwners,
    bus: inputs.bus,
    log: inputs.log,
    written: inputs.metrics.inboxEntries,
    collapsed: inputs.metrics.inboxCollapsed,
    pushedKinds: inputs.composition.pushedKinds,
    suspended: () => inputs.composition.suspension.current().has(module),
    ...(inputs.push === undefined ? {} : { push: inputs.push }),
  });

/** What a worker or a consumer of each module is handed to notify and to publish (`ModuleSeams`). */
export const seamsOfModules = (inputs: SeamInputs): ((module: string) => ModuleSeams) => {
  const shared = factContextOf(inputs);
  return (module) => moduleSeams(module, sinkOfModule(module, inputs), shared);
};
