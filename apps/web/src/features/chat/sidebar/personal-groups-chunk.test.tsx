/** A failed optional view must leave its channels reachable, with an explicit retry. */
import { afterAll, expect, mock, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../../app/outlet';
import { installDom } from '../../../testing/dom';
import { aChannel, aSignedInApi, IDS } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();
const real = { ...(await import('../../../app/deferred')) };
const path = require.resolve('../../../app/deferred');
const online = async (): Promise<void> => {
  Reflect.deleteProperty(require.cache, path);
  await mock.module('../../../app/deferred', () => real);
};
afterAll(online);
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

test('a failed group view keeps the channel in Channels; Retry installs the heading and moves the row exactly once', async () => {
  Reflect.deleteProperty(require.cache, path);
  let attempts = 0;
  await mock.module('../../../app/deferred', () => {
    attempts += 1;
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const groupId = '00000000-0000-4000-8000-0000000000f1';
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi({
      channels: () =>
        Promise.resolve([aChannel(IDS.api, 'Operations', { sidebarGroupId: groupId })]),
      channelGroups: () =>
        Promise.resolve({
          data: [{ id: groupId, name: 'Finance', collapsed: false }],
          nextCursor: null,
        }),
      messages: () => Promise.resolve({ data: [], nextCursor: null }),
    }),
  });
  await settle();
  expect(attempts).toBe(1);
  expect(
    within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', {
      name: 'Operations',
    }),
  ).toBeTruthy();
  expect(view.queryByRole('navigation', { name: 'Channel group: Finance' })).toBeNull();
  await online();
  await person().click(view.getByRole('button', { name: 'Retry' }));
  await settle();
  expect(
    within(view.getByRole('navigation', { name: 'Channel group: Finance' })).getByRole('link', {
      name: 'Operations',
    }),
  ).toBeTruthy();
  expect(
    within(view.getByRole('navigation', { name: 'Channels' })).queryByRole('link', {
      name: 'Operations',
    }),
  ).toBeNull();
});
