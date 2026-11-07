/**
 * What the composition holds of how modules tell one another things, with modules that are not chat or issues (D-283 §3): `notes`
 * publishes a fact and provides a capability, `wiki` consumes the one and uses the other. What the manifests say and what the
 * slots supply must be the same names, and a port is there only where its provider is run, as `undefined` and not as a stub.
 * Nothing here publishes or delivers: the skeleton is the contract, and the behaviour built on it has its own tests
 * (`outbox.integration.test.ts`, `outbox-drain.integration.test.ts`, `outbox-consumer.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { compose, type BundledModule } from './composition';
import { DEFAULT_WORKER_DEADLINE_MS } from './modules/workers/module-workers';
import { NOTE_CREATED } from './testing/facts';
import type { FactConsumer } from './platform/fact-consumers';
import type { Port } from './platform/ports/ports';

interface ChannelAccess {
  readonly canPost: (channelId: string) => boolean;
}

const FACTS_OF_THE_TEST = [NOTE_CREATED];

const base = {
  requires: [],
  optional: [],
  degrades: {},
  provides: [],
  budget: { none: 'a test module' },
};
const consumer: FactConsumer = () => Promise.resolve('done');
const access: ChannelAccess = { canPost: () => true };

const notes = (overrides: Partial<BundledModule> = {}): BundledModule => ({
  manifest: {
    ...base,
    id: 'notes',
    provides: ['notes.channel-access'],
    publishes: ['notes.created'],
  },
  ports: { 'notes.channel-access': access },
  ...overrides,
});

const wiki = (overrides: Partial<BundledModule> = {}): BundledModule => ({
  manifest: {
    ...base,
    id: 'wiki',
    optional: ['notes'],
    consumes: ['notes.created'],
    uses: ['notes.channel-access'],
  },
  factConsumers: { 'notes.created': consumer },
  ...overrides,
});

describe('the handler of a fact a module consumes', () => {
  test('is supplied for the type the manifest names, and for no other', () => {
    expect(() =>
      compose([notes(), wiki()], [notes(), wiki()], 'open', FACTS_OF_THE_TEST),
    ).not.toThrow();
  });

  test('stops the build when a consumed type has no handler', () => {
    expect(() =>
      compose([notes(), wiki({ factConsumers: {} })], undefined, 'open', FACTS_OF_THE_TEST),
    ).toThrow(
      '"wiki" consumes the facts notes.created in its manifest and supplies no handler for them',
    );
  });

  test('stops the build when a handler is for a type the manifest does not name', () => {
    const extra = wiki({
      factConsumers: { 'notes.created': consumer, 'notes.moved': consumer },
    });
    expect(() => compose([notes(), extra], undefined, 'open', FACTS_OF_THE_TEST)).toThrow(
      '"wiki" supplies handlers for notes.moved, which its manifest does not name under consumes',
    );
  });
});

describe('the port of a capability a module provides', () => {
  test('is supplied for the name the manifest lists, and for no other', () => {
    expect(() => compose([notes()])).not.toThrow();
  });

  test('stops the build when a provided capability has no implementation', () => {
    expect(() => compose([notes({ ports: {} })])).toThrow(
      '"notes" provides notes.channel-access in its manifest and supplies no implementation for it',
    );
  });

  test('stops the build when an implementation is for a capability the manifest does not list', () => {
    const extra = notes({ ports: { 'notes.channel-access': access, 'notes.other': access } });
    expect(() => compose([extra])).toThrow(
      '"notes" supplies implementations for notes.other, which its manifest does not list under provides',
    );
  });
});

describe('what a module that uses a capability is handed', () => {
  test('the port where its provider is run', () => {
    const composition = compose([notes(), wiki()], undefined, 'open', FACTS_OF_THE_TEST);
    expect(composition.ports['notes.channel-access']).toBe(access);
  });

  test('nothing where its provider is bundled and not run, and the caller has to say what that means', () => {
    const composition = compose([wiki()], [notes(), wiki()], 'open', FACTS_OF_THE_TEST);
    const port: Port<ChannelAccess> = composition.ports['notes.channel-access'] as
      ChannelAccess | undefined;
    expect(port).toBeUndefined();
    const hides = (held: Port<ChannelAccess>): boolean => held?.canPost('c1') ?? false;
    expect(hides(port)).toBe(false);
    // @ts-expect-error a port that may be absent cannot be called as if it were there
    const unguarded = (held: Port<ChannelAccess>): boolean => held.canPost('c1');
    expect(unguarded).toBeInstanceOf(Function);
  });
});

describe('the search sources of a module, asked by the find (D-285)', () => {
  const source = { id: 'notes', search: (): Promise<[]> => Promise.resolve([]) };
  const searching = (overrides: Partial<BundledModule> = {}): BundledModule => ({
    manifest: { ...base, id: 'notes', searchSources: ['notes'] },
    searchSources: [source],
    ...overrides,
  });

  test('are supplied for the ids the manifest lists, and for no other', () => {
    expect(() => compose([searching()])).not.toThrow();
  });

  test('stop the build when a listed source has nothing behind it', () => {
    expect(() => compose([searching({ searchSources: [] })])).toThrow(
      '"notes" lists the search sources notes in its manifest and supplies nothing behind them',
    );
  });

  test('stop the build when a supplied source is not listed', () => {
    const unlisted = { manifest: { ...base, id: 'notes' }, searchSources: [source] };
    expect(() => compose([unlisted])).toThrow(
      '"notes" supplies the search sources notes, which its manifest does not list under searchSources',
    );
  });

  test('are asked only of a module that runs, and the others’ ids are the ones answered off', () => {
    const wikiSearching: BundledModule = {
      manifest: { ...base, id: 'wiki', searchSources: ['pages'] },
      searchSources: [{ id: 'pages', search: source.search }],
    };
    const own = searching();
    const composition = compose([own], [own, wikiSearching]);
    expect(composition.findSources.map(({ module, source: asked }) => [module, asked.id])).toEqual([
      ['notes', 'notes'],
    ]);
    expect(composition.findSourcesOff).toEqual(['pages']);
  });
});

describe('the worker that delivers the facts a module consumes', () => {
  test('is made for a module that runs and has handlers, as a worker of that module', () => {
    const composition = compose([notes(), wiki()], undefined, 'open', FACTS_OF_THE_TEST);
    expect(
      composition.workers.map(({ module, name, intervalMs }) => ({ module, name, intervalMs })),
    ).toEqual([{ module: 'wiki', name: 'outbox:consume', intervalMs: 2000 }]);
    expect(composition.workers[0]?.deadlineMs).toBe(DEFAULT_WORKER_DEADLINE_MS);
  });

  test('is held to the deadline of its module’s manifest, or to none when the module declared none', () => {
    const slow = wiki({ manifest: { ...wiki().manifest, workerDeadline: { ms: 5000 } } });
    expect(
      compose([notes(), slow], undefined, 'open', FACTS_OF_THE_TEST).workers[0]?.deadlineMs,
    ).toBe(5000);
    const free = wiki({
      manifest: {
        ...wiki().manifest,
        workerDeadline: { none: 'a test of a module with no deadline' },
      },
    });
    expect(
      compose([notes(), free], undefined, 'open', FACTS_OF_THE_TEST).workers[0]?.deadlineMs,
    ).toBe(undefined);
  });

  test('is not made for a module that is not run, nor for one without handlers', () => {
    expect(compose([notes()], [notes(), wiki()], 'open', FACTS_OF_THE_TEST).workers).toEqual([]);
    expect(compose([notes(), wiki()], undefined, 'open', FACTS_OF_THE_TEST).workers).toHaveLength(
      1,
    );
    expect(compose([notes()], undefined, 'open', FACTS_OF_THE_TEST).workers).toEqual([]);
  });

  test('is one a module cannot also declare, so a module’s own loop cannot take its name', () => {
    const own = wiki({
      manifest: { ...wiki().manifest, entitlement: 'always' },
      workers: [
        { name: 'outbox:consume', intervalMs: 5000, work: (): Promise<void> => Promise.resolve() },
      ],
    });
    expect(() => compose([notes(), own], undefined, 'open', FACTS_OF_THE_TEST)).toThrow(
      '"wiki" has two workers called "outbox:consume"',
    );
  });

  test('stops the build when a handler is for a type no declaration describes', () => {
    expect(() => compose([notes(), wiki()], undefined, 'open', [])).toThrow(
      '"wiki" has a handler for the fact "notes.created", which no declaration describes',
    );
  });
});
