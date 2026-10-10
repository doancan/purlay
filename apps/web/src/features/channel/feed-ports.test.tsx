/**
 * The browser's own ports for the feed, against stand-ins for the observers the test DOM
 * does not have: they must be set up on the element asked about, report what the observer
 * reports, and let go when told.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { FeedPortsContext, useFeedPorts, type FeedPorts } from './feed-ports';
import { renderApp } from '../../testing/render';

installDom();

const original = { io: globalThis.IntersectionObserver, ro: globalThis.ResizeObserver };
afterEach(() => {
  globalThis.IntersectionObserver = original.io;
  globalThis.ResizeObserver = original.ro;
});

const defaultPorts = async (): Promise<FeedPorts> => {
  const seen: FeedPorts[] = [];
  const Probe = (): null => {
    seen.push(useFeedPorts());
    return null;
  };
  await renderApp(<Probe />);
  const [ports] = seen;
  if (ports === undefined) throw new Error('the probe did not render');
  return ports;
};

describe('the browser ports', () => {
  test('say when the target is visible inside the root, and only when it is', async () => {
    let callback: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    let options: { root?: Element } = {};
    const seen: { observed: Element[]; disconnected: number } = { observed: [], disconnected: 0 };
    globalThis.IntersectionObserver = class {
      constructor(cb: typeof callback, init: typeof options) {
        callback = cb;
        options = init;
      }
      observe(element: Element): void {
        seen.observed.push(element);
      }
      disconnect(): void {
        seen.disconnected += 1;
      }
    } as unknown as typeof IntersectionObserver;
    const ports = await defaultPorts();
    const target = document.createElement('div');
    const root = document.createElement('div');
    let visible = 0;
    const stop = ports.whenVisible(target, root, () => {
      visible += 1;
    });
    expect(seen.observed).toEqual([target]);
    expect(options.root).toBe(root);
    callback([{ isIntersecting: false }]);
    expect(visible).toBe(0);
    callback([{ isIntersecting: false }, { isIntersecting: true }]);
    expect(visible).toBe(1);
    stop();
    expect(seen.disconnected).toBe(1);
  });

  test('say when anything watched changes size, and stop', async () => {
    let callback: () => void = () => undefined;
    const seen: { observed: Element[]; disconnected: number } = { observed: [], disconnected: 0 };
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        callback = cb;
      }
      observe(element: Element): void {
        seen.observed.push(element);
      }
      disconnect(): void {
        seen.disconnected += 1;
      }
    } as unknown as typeof ResizeObserver;
    const ports = await defaultPorts();
    const a = document.createElement('div');
    const b = document.createElement('div');
    let resized = 0;
    const stop = ports.whenResized([a, b], () => {
      resized += 1;
    });
    expect(seen.observed).toEqual([a, b]);
    callback();
    expect(resized).toBe(1);
    stop();
    expect(seen.disconnected).toBe(1);
  });

  test('know whether the page is in front of the person, and hear when that changes', async () => {
    const ports = await defaultPorts();
    expect(typeof ports.pageVisible()).toBe('boolean');
    let heard = 0;
    const stop = ports.onPageVisibility(() => {
      heard += 1;
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(heard).toBe(1);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(heard).toBe(1);
  });

  test('carry the real clock and timer, and a context replaces them wholesale', async () => {
    const ports = await defaultPorts();
    const before = Date.now();
    expect(ports.clock.now().getTime()).toBeGreaterThanOrEqual(before);
    let fired = false;
    const cancel = ports.schedule(() => {
      fired = true;
    }, 10_000);
    cancel();
    expect(fired).toBe(false);

    const stand: FeedPorts = { ...ports, pageVisible: () => false };
    let seen = true;
    const Probe = (): null => {
      seen = useFeedPorts().pageVisible();
      return null;
    };
    await renderApp(
      <FeedPortsContext.Provider value={stand}>
        <Probe />
      </FeedPortsContext.Provider>,
    );
    expect(seen).toBe(false);
  });
});
