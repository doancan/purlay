/**
 * "Reconnecting…": when it appears, when it does not, and what it never does.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { CLOSE_CODES } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { IDS, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const frame = async (): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi(),
  });
  await settle();
  return view;
};

const bar = (view: Awaited<ReturnType<typeof renderApp>>): HTMLElement | undefined =>
  view.queryAllByRole('status').find((s) => s.textContent.includes('Reconnecting'));

describe('the connection bar', () => {
  test('is not there while the page is connecting for the first time', async () => {
    const view = await frame();
    expect(bar(view)).toBeUndefined();
  });

  test('is not there while the connection is open', async () => {
    const view = await frame();
    act(() => {
      view.world.sockets.open();
    });
    expect(bar(view)).toBeUndefined();
  });

  test('appears when a connection that was open is lost, and goes when it is back', async () => {
    const view = await frame();
    act(() => {
      view.world.sockets.open();
    });
    act(() => {
      view.world.sockets.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    });
    expect(bar(view)?.textContent).toContain('Reconnecting… messages will send when you are back');
    for (let waited = 0; view.world.sockets.sockets.length < 2 && waited < 5_000; waited += 100) {
      act(() => {
        view.world.timers.advance(100);
      });
    }
    act(() => {
      view.world.sockets.open();
    });
    expect(bar(view)).toBeUndefined();
  });

  test('is a status and not an alert, and leaves the composer enabled', async () => {
    const view = await frame();
    act(() => {
      view.world.sockets.open();
    });
    act(() => {
      view.world.sockets.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    });
    expect(bar(view)?.getAttribute('role')).toBe('status');
    expect(view.container.querySelectorAll('button[disabled], textarea[disabled]')).toHaveLength(0);
  });

  test('is not shown for a session that has ended: that is not a reconnect', async () => {
    const view = await frame();
    act(() => {
      view.world.sockets.open();
    });
    act(() => {
      view.world.sockets.sockets.at(-1)?.handlers.closed(CLOSE_CODES.SESSION_ENDED);
    });
    expect(bar(view)).toBeUndefined();
  });
});
