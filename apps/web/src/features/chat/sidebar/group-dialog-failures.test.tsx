/** Refusals retain input, and a failed group read can be retried without losing access to Channels. */
import { expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { ChannelGroupPage, ErrorCode } from '@purlay/types';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { installDom } from '../../../testing/dom';
import { aChannel, aSignedInApi, IDS } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { SessionGate } from '../../session/session';
import { WorkspaceScopeProvider } from '../../shell/workspace';
import { ChannelGroupEditor, MoveChannelGroupDialog } from './group-dialogs';
import { Outlet } from '../../../app/outlet';

installDom();
const groupId = '00000000-0000-4000-8000-0000000000f1';
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const Scope = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <SessionGate>
    <WorkspaceScopeProvider slug="acme" notFound={<p>missing</p>}>
      {children}
    </WorkspaceScopeProvider>
  </SessionGate>
);

for (const code of [
  'CHANNEL_GROUP_NAME_TAKEN',
  'VALIDATION_FAILED',
  'CHANNEL_GROUP_LIMIT',
] as const satisfies readonly ErrorCode[]) {
  test(`${code} preserves the name and identifies whether the field can fix the refusal`, async () => {
    let calls = 0;
    const view = await renderApp(
      <Scope>
        <ChannelGroupEditor open onOpenChange={() => undefined} />
      </Scope>,
      {
        api: aSignedInApi({
          saveChannelGroup: () => {
            calls += 1;
            return Promise.reject(new ApiError(409, code, 'refused'));
          },
        }),
      },
    );
    await settle();
    const field = view.getByRole('textbox', { name: 'Group name' });
    await person().type(field, 'Satış');
    await person().click(view.getByRole('button', { name: 'Create group' }));
    await settle();
    expect(calls).toBe(1);
    expect(view.getByRole('alert')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('Satış');
    expect(field.getAttribute('aria-invalid') === 'true').toBe(code !== 'CHANNEL_GROUP_LIMIT');
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    expect((field as HTMLInputElement).value).toBe('');
  });
}

test('loading and failed group reads disable moving; Retry recovers and a failed move preserves the choice', async () => {
  const loading = Promise.withResolvers<ChannelGroupPage>();
  let reads = 0;
  let refuseMove = true;
  const selected: (string | null)[] = [];
  const Probe = (): React.JSX.Element => {
    const [open, setOpen] = useState(true);
    return (
      <MoveChannelGroupDialog
        open={open}
        onOpenChange={setOpen}
        channel={aChannel(IDS.api, 'api')}
      />
    );
  };
  const view = await renderApp(
    <Scope>
      <Probe />
    </Scope>,
    {
      api: aSignedInApi({
        channelGroups: async () => {
          reads += 1;
          return reads === 1
            ? await loading.promise
            : { data: [{ id: groupId, name: 'Finance', collapsed: false }], nextCursor: null };
        },
        moveChannelGroup: (_channelId, id) => {
          selected.push(id);
          return refuseMove
            ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
            : Promise.resolve(aChannel(IDS.api, 'api', { sidebarGroupId: id }));
        },
      }),
    },
  );
  await settle();
  expect(view.getByRole('status').textContent).toContain('Loading');
  expect((view.getByRole('button', { name: 'Move channel' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => {
    loading.reject(new Error('offline'));
    await Promise.resolve();
  });
  await settle();
  expect(view.getByRole('alert')).toBeTruthy();
  expect((view.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  await person().click(view.getByRole('button', { name: 'Retry' }));
  await settle();
  await person().selectOptions(view.getByRole('combobox'), groupId);
  await person().click(view.getByRole('button', { name: 'Move channel' }));
  await settle();
  expect(view.getByRole('alert')).toBeTruthy();
  expect((view.getByRole('combobox') as HTMLSelectElement).value).toBe(groupId);
  refuseMove = false;
  await person().click(view.getByRole('button', { name: 'Move channel' }));
  await settle();
  expect(selected).toEqual([groupId, groupId]);
  expect(view.queryByRole('dialog')).toBeNull();
});

test('an empty list offers Channels, and cancelling sends no move', async () => {
  let moves = 0;
  const Probe = (): React.JSX.Element => {
    const [open, setOpen] = useState(true);
    return (
      <MoveChannelGroupDialog
        open={open}
        onOpenChange={setOpen}
        channel={aChannel(IDS.api, 'api')}
      />
    );
  };
  const view = await renderApp(
    <Scope>
      <Probe />
    </Scope>,
    {
      api: aSignedInApi({
        moveChannelGroup: () => {
          moves += 1;
          return Promise.resolve(aChannel(IDS.api, 'api'));
        },
      }),
    },
  );
  await settle();
  expect(view.getByRole('option', { name: 'Channels' })).toBeTruthy();
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  expect(view.queryByRole('dialog')).toBeNull();
  expect(moves).toBe(0);
});

test('revoking channel membership closes an open move and does not reopen it when membership returns', async () => {
  let channels = [aChannel(IDS.api, 'api')];
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi({
      channels: () => Promise.resolve(channels),
      messages: () => Promise.resolve({ data: [], nextCursor: null }),
    }),
  });
  await settle();
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
  expect(view.getByRole('dialog', { name: 'Move api' })).toBeTruthy();
  const key = keys.channels(channels[0]?.workspaceId ?? '');
  channels = [aChannel(IDS.api, 'api', { state: null })];
  await act(async () => {
    view.world.client.setQueryData(key, channels);
    await Promise.resolve();
  });
  await settle();
  // Keep the failing mutation's report scalar: Bun can recursively inspect the mounted React tree.
  expect(view.queryByRole('dialog') === null).toBe(true);
  channels = [aChannel(IDS.api, 'api')];
  await act(async () => {
    view.world.client.setQueryData(key, channels);
    await Promise.resolve();
  });
  await settle();
  expect(view.queryByRole('dialog') === null).toBe(true);
});
