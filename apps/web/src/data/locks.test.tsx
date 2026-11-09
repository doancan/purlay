import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom } from '../testing/dom';
import { renderApp } from '../testing/render';
import { TestLocks } from '../testing/locks';
import { LocksContext, useLocks } from './locks';

installDom();

const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(navigator, 'locks');
  else Object.defineProperty(navigator, 'locks', original);
});

const Availability = (): React.JSX.Element => (
  <span>{useLocks() === null ? 'Coordination unavailable' : 'Coordination available'}</span>
);

describe('native tab coordination availability', () => {
  test('prerendering without a browser reports coordination as unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
      expect(renderToStaticMarkup(<Availability />)).toContain('Coordination unavailable');
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'navigator');
      else Object.defineProperty(globalThis, 'navigator', descriptor);
    }
  });
  test('without a supplied port, a supported browser uses its native manager', async () => {
    const native = new TestLocks();
    Object.defineProperty(navigator, 'locks', { value: native, configurable: true });
    const Identity = (): React.JSX.Element => (
      <span>{useLocks() === native ? 'Native manager' : 'Other manager'}</span>
    );
    const view = await renderApp(
      <LocksContext.Provider value={undefined}>
        <Identity />
      </LocksContext.Provider>,
    );
    expect(view.getByText('Native manager')).toBeTruthy();
    view.unmount();
  });
});
