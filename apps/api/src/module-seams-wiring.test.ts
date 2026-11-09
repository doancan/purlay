/**
 * The seams `index.ts` hands the workers and consumers of each module (D-283 §2, D-286 §13): the sink of that module, with the kinds the
 * running modules declare, and the publishing context of the build. What they do with a database is
 * `modules/inbox/module-seams.integration.test.ts`; here, what is refused before one is reached.
 */
import { describe, expect, test } from 'bun:test';
import { compose } from './composition';
import { issuesModule } from './features/issues/module';
import { createMetricsRegistry } from './platform/metrics';
import { type moduleSeams } from './platform/ports/module-seams';
import { mintTurn } from './platform/workspace-turn';
import { seamsOfModules } from './module-seams-wiring';
import { fixedClock } from './platform/clock';
import type { EventBus } from './platform/events';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  aTransactionThatMustNotBeTouched,
} from './testing/doubles';

const registry = createMetricsRegistry();
const bus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const counter = (name: string): ReturnType<typeof registry.counter<'module' | 'kind'>> =>
  registry.counter(name, name, ['module', 'kind']);
const factCounter = (name: string): ReturnType<typeof registry.counter<'module' | 'fact'>> =>
  registry.counter(name, name, ['module', 'fact']);

const seamsFor = seamsOfModules({
  composition: compose([issuesModule], [issuesModule]),
  clock: fixedClock(new Date('2026-01-01T00:00:00Z')),
  bus,
  log: aRecordingLogger().log,
  metrics: {
    outboxDropped: factCounter('wired_dropped'),
    outboxRefused: factCounter('wired_refused'),
    inboxEntries: counter('wired_entries'),
    inboxCollapsed: counter('wired_collapsed'),
  },
  outboxPendingMax: 100,
});

const failureOf = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'it was accepted',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('the seams of a module in the running build', () => {
  const turn = mintTurn({ workspaceId: 'w', modules: null });
  const bound = (): ReturnType<ReturnType<typeof moduleSeams>['bind']> =>
    seamsFor('issues').bind(aTransactionThatMustNotBeTouched(), turn);

  test('refuse a kind of notice the running modules do not declare, before a database is used', async () => {
    const message = await failureOf(
      bound().seam.notify({
        kind: 'unheard_of',
        recipientId: 'r',
        subject: { type: 'issue', id: 'i' },
        params: {},
      }),
    );
    expect(message).toMatch(/no running module declares the notification kind "unheard_of"/);
  });

  test('refuse a fact in no transaction, and the announce of nothing is nothing', async () => {
    const seams = seamsFor('issues');
    const outside = seams.bind(aDatabaseThatMustNotBeTouched() as never, turn);
    expect(
      await failureOf(outside.seam.publishFact({ type: 'issues.none' } as never, {} as never)),
    ).toMatch(/not in a transaction|not its publisher|publish/);
    await seams.announce([]);
    expect(bound().written()).toEqual([]);
  });
});
