/** Personal headings must preserve one visible route into every joined channel (#1198). */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../../app/outlet';
import { installDom } from '../../../testing/dom';
import { aChannel, aSignedInApi, IDS } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { ApiError } from '../../../data/errors';
import { Toaster } from '../../../ui/toast';
import { keys } from '../../../data/keys';
import { expectFocusOn } from '../../../testing/focus';

installDom();
const groupId = '00000000-0000-4000-8000-0000000000f1';
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

describe('personal channel headings', () => {
  test('retrying the metadata read restores headings in name order, and a removed heading returns dialog focus to sidebar options', async () => {
    let offline = true;
    const headings = [
      { id: groupId, name: 'Sales', collapsed: false },
      { id: '00000000-0000-4000-8000-0000000000f2', name: 'Finance', collapsed: false },
    ];
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
        channelGroups: () =>
          offline
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({ data: headings, nextCursor: null }),
      }),
    });
    await settle();
    expect(view.getByText('Channel groups couldn’t load')).toBeTruthy();
    offline = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      view
        .getAllByRole('navigation')
        .map((nav) => nav.getAttribute('aria-label'))
        .filter((name) => name?.startsWith('Channel group:')),
    ).toEqual(['Channel group: Finance', 'Channel group: Sales']);
    await person().click(view.getByRole('button', { name: 'Options for Sales' }));
    await person().click(view.getByRole('menuitem', { name: 'Rename group' }));
    await settle();
    const dialog = within(view.getByRole('dialog', { name: 'Rename group' }));
    await act(async () => {
      view.world.client.setQueryData(keys.channelGroups(IDS.workspace), {
        data: [],
        nextCursor: null,
      });
      await Promise.resolve();
    });
    await person().click(dialog.getByRole('button', { name: 'Cancel' }));
    await settle();
    expectFocusOn(view.getByRole('button', { name: /^Sidebar options/ }));
  });
  test('folding preserves unread and current channels, and a refused fold restores the header with an explanation', async () => {
    const view = await renderApp(
      <>
        <Outlet />
        <Toaster dismissLabel="Close" />
      </>,
      {
        path: `/w/acme/c/${IDS.api}`,
        api: aSignedInApi({
          channels: () =>
            Promise.resolve([
              aChannel(IDS.api, 'Current', { sidebarGroupId: groupId }),
              aChannel(IDS.deploys, 'Unread', {
                sidebarGroupId: groupId,
                state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 0 },
              }),
              aChannel(IDS.incidents, 'Quiet', { sidebarGroupId: groupId }),
            ]),
          channelGroups: () =>
            Promise.resolve({
              data: [{ id: groupId, name: 'Operations', collapsed: true }],
              nextCursor: null,
            }),
          foldChannelGroup: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
        }),
      },
    );
    await settle();
    const group = within(view.getByRole('navigation', { name: 'Channel group: Operations' }));
    expect(group.getByRole('link', { name: 'Current' })).toBeTruthy();
    expect(group.getByRole('link', { name: /Unread/ })).toBeTruthy();
    expect(group.queryByRole('link', { name: 'Quiet' })).toBeNull();
    await person().click(group.getByRole('button', { name: 'Operations' }));
    await settle();
    expect(group.getByRole('button', { name: 'Operations' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(group.queryByRole('link', { name: 'Quiet' })).toBeNull();
    expect(view.getByText(/The channel group couldn’t be updated/).textContent).toContain(
      'connection',
    );
  });
  test('a grouped channel appears once under its own heading and other channels stay in Channels', async () => {
    const api = aSignedInApi({
      channels: () =>
        Promise.resolve([
          aChannel(IDS.api, 'Satış', { sidebarGroupId: groupId }),
          aChannel(IDS.deploys, 'Depo'),
        ]),
      channelGroups: () =>
        Promise.resolve({
          data: [{ id: groupId, name: 'Finans', collapsed: false }],
          nextCursor: null,
        }),
    });
    const view = await renderApp(<Outlet />, { path: '/w/acme/c/' + IDS.api, api });
    await settle();
    expect(
      within(view.getByRole('navigation', { name: 'Channel group: Finans' })).getByRole('link', {
        name: 'Satış',
      }),
    ).toBeTruthy();
    const ordinary = within(view.getByRole('navigation', { name: 'Channels' }));
    expect(ordinary.queryByRole('link', { name: 'Satış' })).toBeNull();
    expect(ordinary.getByRole('link', { name: 'Depo' })).toBeTruthy();
  });

  test('an unknown or unavailable heading never makes a channel unreachable', async () => {
    const api = aSignedInApi({
      channels: () => Promise.resolve([aChannel(IDS.api, 'Satış', { sidebarGroupId: groupId })]),
      channelGroups: () => Promise.reject(new Error('offline')),
    });
    const view = await renderApp(<Outlet />, { path: '/w/acme/c/' + IDS.api, api });
    await settle();
    expect(
      within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', {
        name: 'Satış',
      }),
    ).toBeTruthy();
  });
});
