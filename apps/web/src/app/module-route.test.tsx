/**
 * A module's screen from its manifest (D-250): the chunk is asked for in the first commit of a route whose module
 * says so and of no other, a stand-in is what the manifest says it is, and a module's chunk is one request however
 * many ask. What a screen does once drawn is the screen's own tests'.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../testing/dom';
import { IDS, aSignedInApi } from '../testing/fixtures';
import { renderApp } from '../testing/render';
import { Outlet } from './outlet';
import { moduleChunk, warmModule, Waiting } from './module-route';

installDom();

interface Warmable {
  warm: () => void;
}

/** Counts the asks for chat's and issues' chunks, the way the doors make them, until the test is over. */
const watching = (): { readonly asked: (id: string) => number; readonly stop: () => void } => {
  const originals = new Map<string, () => void>();
  const counts = new Map<string, number>();
  for (const id of ['chat', 'issues']) {
    const chunk = moduleChunk(id) as Warmable;
    originals.set(id, chunk.warm);
    chunk.warm = (): void => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    };
  }
  return {
    asked: (id: string): number => counts.get(id) ?? 0,
    stop: (): void => {
      for (const [id, warm] of originals) (moduleChunk(id) as Warmable).warm = warm;
    },
  };
};

let watch: ReturnType<typeof watching> | null = null;
afterEach(() => {
  watch?.stop();
  watch = null;
});

describe('asking for a module’s chunk before anything waits on it', () => {
  test('a chat address asks for chat’s chunk in the first commit, and no other module’s', async () => {
    watch = watching();
    await renderApp(<Outlet />, { path: `/w/acme/c/${IDS.api}`, api: aSignedInApi() });
    expect(watch.asked('chat')).toBeGreaterThan(0);
    expect(watch.asked('issues')).toBe(0);
  });

  test('a core address asks for none, and an address of a module that does not say so asks for none', async () => {
    watch = watching();
    await renderApp(<Outlet />, { path: '/w/acme/settings', api: aSignedInApi() });
    await renderApp(<Outlet />, { path: '/w/acme/issues', api: aSignedInApi() });
    expect(watch.asked('chat')).toBe(0);
    expect(watch.asked('issues')).toBe(0);
  });

  test('nobody’s route, a module that is not there and the core’s own ask for nothing and do not fail', () => {
    watch = watching();
    warmModule(null);
    warmModule('no-such-module');
    expect(watch.asked('chat')).toBe(0);
    expect(() => moduleChunk('no-such-module')).toThrow('no module is called no-such-module');
  });

  test('a chunk is one request: every ask for it is the same promise', () => {
    expect(moduleChunk('chat').get()).toBe(moduleChunk('chat').get());
    expect(moduleChunk('issues').get()).toBe(moduleChunk('issues').get());
  });
});

describe('what stands in for a screen while its chunk comes', () => {
  test('a `bar` module’s keeps the shell’s bar, which holds the navigation toggle a narrow cold load is measured to', async () => {
    const view = await renderApp(<Waiting kind="bar" />);
    expect(view.container.querySelector('header')).not.toBeNull();
    expect(view.getByRole('status')).toBeDefined();
  });

  test('a `plain` module’s is the skeleton alone', async () => {
    const view = await renderApp(<Waiting kind="plain" />);
    expect(view.container.querySelector('header')).toBeNull();
    expect(view.getByRole('status')).toBeDefined();
  });
});
