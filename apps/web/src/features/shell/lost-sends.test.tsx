/**
 * Unsent messages that went with a channel the person lost (#521): said once, in words, with how many.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { families } from '../../data/keys';
import { IDS, aSignedInApi, someChannels } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('unsent messages of a channel that went away', () => {
  test('are said to be gone, once, with how many, in the person’s language', async () => {
    const view = await renderApp(
      <>
        <Outlet />
        <Toaster dismissLabel="Close" />
      </>,
      {
        path: `/w/acme/c/${IDS.api}`,
        api: aSignedInApi(),
      },
    );
    await settle();
    act(() => {
      view.world.sockets.open();
    });
    await settle();
    // Two sends the server never answers.
    const box = view.getByLabelText(/^Message/);
    await person().type(box, 'first{Enter}');
    await person().type(box, 'second{Enter}');
    await settle();
    act(() => {
      view.world.sockets.deliver({
        event: 'ACCESS_REVOKED',
        data: { channelIds: [IDS.api], reason: 'archived' },
        ts: 1_757_419_200_000,
      });
    });
    await settle();
    const said = view
      .getAllByRole('status')
      .filter((s) => s.textContent.includes('not yet delivered'));
    expect(said).toHaveLength(1);
    expect(said[0]?.textContent).toContain('2 messages not yet delivered were removed');
    view.unmount();
  });

  test('a channel gone from the list read again, as after a time offline, takes its unsent message, said in Turkish', async () => {
    let list = someChannels();
    const view = await renderApp(
      <>
        <Outlet />
        <Toaster dismissLabel="Kapat" />
      </>,
      {
        path: `/w/acme/c/${IDS.api}`,
        api: aSignedInApi({ channels: () => Promise.resolve(list) }),
        locale: 'tr',
      },
    );
    await settle();
    act(() => {
      view.world.sockets.open();
    });
    await settle();
    await person().type(view.getByLabelText(/^Mesaj: /), 'yolda{Enter}');
    await settle();
    // Nobody said ACCESS_REVOKED: the channel is simply not in the list read again.
    list = list.filter((c) => c.id !== IDS.api);
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: families.channels });
    });
    await settle();
    const said = view.getAllByRole('status').filter((s) => s.textContent.includes('kaldırıldı'));
    expect(said).toHaveLength(1);
    expect(said[0]?.textContent).toContain('Teslim edilmemiş bir mesaj kaldırıldı');
    view.unmount();
  });
});
