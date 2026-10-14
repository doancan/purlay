/**
 * The page says it is in front of its person (D-143) — on their input, while it is visible and
 * focused — and says nothing from a tab that is hidden or not focused, so their phone still buzzes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { IDS, WORKSPACE, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** The page's document, as visible and focused as the test says; answers how to put it back. */
const facing = (visible: boolean, focused: boolean): (() => void) => {
  // Own properties over the prototype's, deleted again to restore it.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  Object.defineProperty(document, 'hasFocus', {
    configurable: true,
    value: (): boolean => focused,
  });
  return (): void => {
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(document, 'hasFocus');
  };
};

let restore: () => void = (): void => undefined;
afterEach(() => {
  restore();
});

const opened = async (): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, { path: `/w/acme/c/${IDS.api}`, api: aSignedInApi() });
  await settle();
  act(() => {
    view.world.sockets.open();
  });
  return view;
};

describe('saying the person is here', () => {
  test('a key pressed on a visible, focused page says so, for this workspace', async () => {
    restore = facing(true, true);
    const view = await opened();
    fireEvent.keyDown(window, { key: 'j' });
    expect(view.world.sockets.sent('ACTIVE').map((frame) => frame.payload)).toEqual([
      { workspaceId: WORKSPACE.id },
    ]);
    view.unmount();
  });

  test('a hidden tab, or one without focus, says nothing however it is touched', async () => {
    for (const [visible, focused] of [
      [false, true],
      [true, false],
    ] as const) {
      restore = facing(visible, focused);
      const view = await opened();
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.pointerDown(window);
      fireEvent(document, new Event('visibilitychange'));
      expect(view.world.sockets.sent('ACTIVE')).toEqual([]);
      view.unmount();
      restore();
    }
    restore = (): void => undefined;
  });

  test('coming to the front says so, before any key', async () => {
    restore = facing(false, false);
    const view = await opened();
    expect(view.world.sockets.sent('ACTIVE')).toEqual([]);
    restore();
    restore = facing(true, true);
    fireEvent(window, new Event('focus'));
    expect(view.world.sockets.sent('ACTIVE')).toHaveLength(1);
    view.unmount();
  });
});
