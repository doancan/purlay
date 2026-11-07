/** A complete personal-group flow, including field/form failures and retry over the same id. */
import { expect, test } from 'bun:test';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { Channel, ChannelGroup } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import { ApiError } from '../../../data/errors';
import { installDom } from '../../../testing/dom';
import { aChannel, aSignedInApi, IDS } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

test('create and retry, fold, move, rename, cancel deletion and delete preserve channels', async () => {
  let groups: ChannelGroup[] = [];
  let channels: Channel[] = [aChannel(IDS.api, 'api')];
  let refuseSave = true;
  let refuseDelete = true;
  const ids: string[] = [];
  const api = aSignedInApi({
    channels: () => Promise.resolve(channels),
    channelGroups: () => Promise.resolve({ data: groups, nextCursor: null }),
    messages: () => Promise.resolve({ data: [], nextCursor: null }),
    saveChannelGroup: (_workspace, id, name) => {
      ids.push(id);
      if (refuseSave) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      const group = {
        id,
        name: name.trim(),
        collapsed: groups.find((entry) => entry.id === id)?.collapsed ?? false,
      };
      groups = [...groups.filter((entry) => entry.id !== id), group];
      return new Promise<ChannelGroup>((resolve) => {
        setTimeout(() => {
          resolve(group);
        }, 25);
      });
    },
    foldChannelGroup: (_workspace, id, collapsed) => {
      const before = groups.find((entry) => entry.id === id);
      if (before === undefined) throw new Error('group missing');
      const group = { ...before, collapsed };
      groups = groups.map((entry) => (entry.id === id ? group : entry));
      return Promise.resolve(group);
    },
    moveChannelGroup: (channelId, groupId) => {
      const before = channels.find((entry) => entry.id === channelId);
      if (before === undefined) throw new Error('channel missing');
      const channel = { ...before, sidebarGroupId: groupId, starred: false };
      channels = [channel];
      return Promise.resolve(channel);
    },
    removeChannelGroup: (_workspace, id) => {
      if (refuseDelete) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      groups = groups.filter((entry) => entry.id !== id);
      channels = channels.map((entry) => ({ ...entry, sidebarGroupId: null }));
      return Promise.resolve();
    },
  });
  const view = await renderApp(<Outlet />, { path: `/w/acme/c/${IDS.api}`, api });
  await settle();
  await person().click(view.getByRole('button', { name: /^Sidebar options/ }));
  await person().click(view.getByRole('menuitem', { name: 'New channel group' }));
  await settle();
  let dialog = within(await view.findByRole('dialog', { name: 'New channel group' }));
  await person().type(dialog.getByRole('textbox', { name: 'Group name' }), '   ');
  await person().click(dialog.getByRole('button', { name: 'Create group' }));
  expect(dialog.getByRole('alert').textContent).toContain('Enter a group name');
  expect(ids).toEqual([]);
  const name = dialog.getByRole('textbox', { name: 'Group name' });
  await person().clear(name);
  await person().type(name, 'Operasyon');
  await person().click(dialog.getByRole('button', { name: 'Create group' }));
  await settle();
  await waitFor(() => {
    expect(dialog.getByRole('alert').textContent).toContain('connection');
  });
  expect(name.getAttribute('aria-invalid')).not.toBe('true');
  expect((name as HTMLInputElement).value).toBe('Operasyon');
  refuseSave = false;
  await person().click(dialog.getByRole('button', { name: 'Create group' }));
  await settle();
  expect(new Set(ids).size).toBe(1);
  await waitFor(() => {
    expect(view.queryByRole('dialog') !== null).toBe(false);
  });
  let group = within(await view.findByRole('navigation', { name: 'Channel group: Operasyon' }));
  await person().click(group.getByRole('button', { name: 'Operasyon' }));
  await settle();
  expect(group.getByRole('button', { name: 'Operasyon' }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  const row = within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', {
    name: 'api',
  });
  await act(async () => {
    row.focus();
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });

    await Promise.resolve();
  });
  await settle();
  await person().click(view.getByRole('menuitem', { name: 'Move to group…' }));
  await settle();
  dialog = within(await view.findByRole('dialog', { name: 'Move api' }));
  await person().selectOptions(dialog.getByLabelText('Group name'), ids[0] ?? '');
  await person().click(dialog.getByRole('button', { name: 'Move channel' }));
  await settle();
  group = within(await view.findByRole('navigation', { name: 'Channel group: Operasyon' }));
  expect(group.getByRole('link', { name: 'api' })).toBeTruthy();
  expect(
    within(view.getByRole('navigation', { name: 'Channels' })).queryByRole('link', { name: 'api' }),
  ).toBeNull();
  await person().click(group.getByRole('button', { name: 'Options for Operasyon' }));
  await person().click(view.getByRole('menuitem', { name: 'Rename group' }));
  await settle();
  dialog = within(await view.findByRole('dialog', { name: 'Rename group' }));
  await person().clear(dialog.getByRole('textbox', { name: 'Group name' }));
  await person().type(dialog.getByRole('textbox', { name: 'Group name' }), 'Finans');
  await person().click(dialog.getByRole('button', { name: 'Save group' }));
  await settle();
  group = within(await view.findByRole('navigation', { name: 'Channel group: Finans' }));
  await person().click(group.getByRole('button', { name: 'Options for Finans' }));
  await person().click(view.getByRole('menuitem', { name: 'Delete group' }));
  await settle();
  dialog = within(await view.findByRole('dialog', { name: 'Delete Finans?' }));
  await person().click(dialog.getByRole('button', { name: 'Cancel' }));
  await settle();
  expect(await view.findByRole('navigation', { name: 'Channel group: Finans' })).toBeTruthy();
  await person().click(group.getByRole('button', { name: 'Options for Finans' }));
  await person().click(view.getByRole('menuitem', { name: 'Delete group' }));
  await settle();
  dialog = within(await view.findByRole('dialog', { name: 'Delete Finans?' }));
  await person().click(dialog.getByRole('button', { name: 'Delete group' }));
  await settle();
  expect(await dialog.findByRole('alert')).toBeTruthy();
  // The modal makes its background inert; the restored heading remains in that background.
  expect(view.container.querySelector('nav[aria-label="Channel group: Finans"]')).not.toBeNull();
  refuseDelete = false;
  await person().click(dialog.getByRole('button', { name: 'Delete group' }));
  await settle();
  await waitFor(() => {
    expect(view.queryByRole('dialog') !== null).toBe(false);
  });
  expect(view.queryByRole('navigation', { name: 'Channel group: Finans' })).toBeNull();
  expect(
    await within(view.getByRole('navigation', { name: 'Channels' })).findByRole('link', {
      name: 'api',
    }),
  ).toBeTruthy();
});
