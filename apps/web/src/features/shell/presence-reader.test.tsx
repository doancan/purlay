/**
 * Who is online is read once the socket is open, never before it: a snapshot read earlier has a gap
 * before the subscription in which somebody coming or going is in no frame and in no snapshot.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
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

describe('the presence snapshot', () => {
  test('waits for the socket to open, and is read once after it', async () => {
    let reads = 0;
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        presence: () => {
          reads += 1;
          return Promise.resolve({ online: [], version: 0 });
        },
      }),
    });
    await settle();
    expect(reads).toBe(0);
    act(() => {
      view.world.sockets.open();
    });
    await settle();
    expect(reads).toBe(1);
    view.unmount();
  });
});
