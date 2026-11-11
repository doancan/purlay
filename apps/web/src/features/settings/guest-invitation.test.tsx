/** Named guest creation through the actual settings frame, API seam, and existing controls. */
import { expect, spyOn, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import {
  PAGE_LIMIT,
  type CreateGuestInvitationRequest,
  type CreatedGuestInvitation,
} from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import { aChannel, aSignedInApi, IDS, ME, WHEN } from '../../testing/fixtures';
import { ContentPortsContext, type ContentPorts } from '../content/content-ports';
import { systemClock } from '../../system-clock';
import { Toaster } from '../../ui/toast';

installDom();

const open = async (
  overrides: Partial<Api> = {},
  copy: ContentPorts['copy'] = () => Promise.resolve(),
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(
    <ContentPortsContext.Provider value={{ highlight: () => Promise.resolve(null), copy }}>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path: '/w/acme/settings/members',
      api: aSignedInApi({
        guests: () => Promise.resolve({ data: [], nextCursor: null }),
        ...overrides,
      }),
    },
  );
  await view.findByRole('heading', { level: 1, name: 'Members' });
  await person().click(view.getByRole('button', { name: 'Guests' }));
  return view;
};
const made = (): CreatedGuestInvitation => ({
  invitation: {
    id: '0199a000-0000-7000-8000-000000000123',
    createdBy: ME,
    createdAt: WHEN,
    expiresAt: '2026-12-01T12:00:00.000Z',
    guest: { channelCount: 1, accessExpiresAt: null },
  },
  token: 'a'.repeat(64),
  guest: { email: 'partner@example.test', channelIds: [IDS.api], accessExpiresAt: null },
  mail: [{ address: 'partner@example.test', outcome: 'unavailable' }],
});

test('availability and channel failures can be retried without creating an invitation', async () => {
  let availability = 0;
  let channelsReady = false;
  let creates = 0;
  const view = await open({
    guestInvitationAvailability: () =>
      ++availability === 1
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve({ enabled: true, email: true }),
    channels: () =>
      channelsReady
        ? Promise.resolve([aChannel(IDS.api, 'api')])
        : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    createGuestInvitation: () => {
      creates += 1;
      return Promise.resolve(made());
    },
  });
  try {
    const user = person();
    await view.findByText('We could not check whether guest invitations are available.');
    await user.click(view.getByRole('button', { name: 'Retry' }));
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    await view.findByText('Channels could not be loaded. Retry before changing the selection.');
    expect(
      (view.getByRole('button', { name: 'Create guest invitation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    channelsReady = true;
    await user.click(view.getByRole('button', { name: 'Retry' }));
    await view.findByRole('checkbox', { name: '#api' });
    await view.findByText('An invitation email will be queued. You can also copy the named link.');
    expect(creates).toBe(0);
    await user.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('textbox', { name: 'Guest email address' }) === null).toBe(true);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});

test('invalid email, empty scope and an invalid end never spend a named invitation', async () => {
  const clock = spyOn(systemClock, 'now').mockReturnValue(new Date('2026-09-09T12:00:00.000Z'));
  const requests: CreateGuestInvitationRequest[] = [];
  const view = await open({
    createGuestInvitation: (_workspace, input) => {
      requests.push(input);
      return Promise.resolve(made());
    },
  });
  try {
    const user = person();
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    await view.findByRole('checkbox', { name: '#api' });
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('Enter a valid email address.');
    await user.type(
      view.getByRole('textbox', { name: 'Guest email address' }),
      'partner@example.test',
    );
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    expect(requests).toHaveLength(0);
    await user.click(view.getByRole('checkbox', { name: '#api' }));
    await user.click(view.getByLabelText('Access end date'));
    await user.click(view.getByRole('button', { name: 'September 8, 2026' }));
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('Choose a valid future date and time.');
    expect(requests).toHaveLength(0);
    await user.click(view.getByLabelText('Access end date'));
    await user.click(view.getByRole('button', { name: 'September 10, 2026' }));
    await user.clear(view.getByLabelText('Access end time'));
    await user.type(view.getByLabelText('Access end time'), '14:30');
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('Guest invitation created.');
    expect(requests).toEqual([
      {
        email: 'partner@example.test',
        channelIds: [IDS.api],
        accessExpiresAt: new Date('2026-09-10T14:30:00').toISOString(),
        locale: 'en',
      },
    ]);
  } finally {
    view.unmount();
    view.world.client.clear();
    clock.mockRestore();
  }
});

test('search and paging retain the selected scope, exclude DMs and enforce the twenty-channel bound', async () => {
  const choices = Array.from({ length: PAGE_LIMIT.default + 1 }, (_, index) =>
    aChannel(
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      `supplier-${String(index).padStart(3, '0')}`,
    ),
  );
  const last = choices.at(-1);
  if (last === undefined) throw new Error('Missing channel fixture');
  const requests: CreateGuestInvitationRequest[] = [];
  const view = await open({
    channels: () =>
      Promise.resolve([...choices, aChannel(IDS.dm, 'private-dm', { type: 'direct_message' })]),
    createGuestInvitation: (_workspace, input) => {
      requests.push(input);
      return Promise.resolve(made());
    },
  });
  try {
    const user = person();
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    await view.findByRole('checkbox', { name: '#supplier-000' });
    expect(view.getAllByRole('checkbox')).toHaveLength(PAGE_LIMIT.default);
    expect(view.queryByRole('checkbox', { name: '#private-dm' }) === null).toBe(true);
    await user.click(view.getByRole('button', { name: 'Show more channels' }));
    await user.click(view.getByRole('checkbox', { name: `#${last.name ?? ''}` }));
    const search = view.getByRole('textbox', { name: 'Find a channel' });
    await user.type(search, 'missing');
    await view.findByText('No matching channels.');
    await user.clear(search);
    await user.type(search, 'supplier');
    await user.click(view.getByRole('checkbox', { name: '#supplier-000' }));
    await user.click(view.getByRole('checkbox', { name: '#supplier-000' }));
    for (let i = 0; i < 19; i += 1)
      await user.click(
        view.getByRole('checkbox', { name: `#supplier-${String(i).padStart(3, '0')}` }),
      );
    expect(
      (view.getByRole('checkbox', { name: '#supplier-019' }) as HTMLInputElement).disabled,
    ).toBe(true);
    await user.type(
      view.getByRole('textbox', { name: 'Guest email address' }),
      'partner@example.test',
    );
    await user.selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'never');
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('Guest invitation created.');
    expect(requests[0]?.channelIds).toEqual([
      last.id,
      ...choices.slice(0, 19).map((channel) => channel.id),
    ]);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});

test('a failed list refresh can recover and clipboard refusal preserves the confirmed link for another attempt', async () => {
  let reads = 0;
  let copies = 0;
  const copied: string[] = [];
  const view = await open(
    {
      guests: () =>
        ++reads === 2
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ data: [], nextCursor: null }),
      createGuestInvitation: () => Promise.resolve(made()),
    },
    (text) => {
      copied.push(text);
      return ++copies === 1 ? Promise.reject(new Error('Clipboard refused')) : Promise.resolve();
    },
  );
  try {
    const user = person();
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    await user.type(
      view.getByRole('textbox', { name: 'Guest email address' }),
      'partner@example.test',
    );
    await user.click(await view.findByRole('checkbox', { name: '#api' }));
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('The invitation was created, but the lists could not be refreshed.');
    const warning = view
      .getByText('The invitation was created, but the lists could not be refreshed.')
      .closest<HTMLElement>('div[role="alert"]');
    if (warning === null) throw new Error('Missing refresh failure alert');
    await user.click(within(warning).getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      view.queryByText('The invitation was created, but the lists could not be refreshed.') ===
        null,
    ).toBe(true);
    await user.click(view.getByRole('button', { name: 'Copy' }));
    await view.findByText("Couldn't copy. Select the text and copy it yourself.");
    await user.click(view.getByRole('button', { name: 'Copy' }));
    await view.findByText('Copied');
    expect(copied).toEqual([
      `${window.location.origin}/invite#${made().token}`,
      `${window.location.origin}/invite#${made().token}`,
    ]);
    await user.click(view.getByRole('button', { name: 'Invite another guest' }));
    expect(
      (view.getByRole('textbox', { name: 'Guest email address' }) as HTMLInputElement).value,
    ).toBe('');
    expect(
      ((await view.findByRole('checkbox', { name: '#api' })) as HTMLInputElement).checked,
    ).toBe(false);
    expect(view.queryByRole('textbox', { name: 'Invitation link' }) === null).toBe(true);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});

test('guest invitation remains closed while deployment readiness is not attested', async () => {
  let creates = 0;
  const view = await open({
    guestInvitationAvailability: () => Promise.resolve({ enabled: false, email: false }),
    createGuestInvitation: () => {
      creates += 1;
      return Promise.resolve(made());
    },
  });
  try {
    const button = await view.findByRole('button', { name: 'Invite a guest' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(
      view.queryByText('Guest invitations have not been enabled by the server administrator.') !==
        null,
    ).toBe(true);
    expect(creates).toBe(0);
    await expectNoAxeViolations(view.container);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});

test('a confirmed named invitation keeps its private copy link when the following refresh fails', async () => {
  let guestReads = 0;
  const requests: CreateGuestInvitationRequest[] = [];
  const view = await open({
    guests: () =>
      ++guestReads === 1
        ? Promise.resolve({ data: [], nextCursor: null })
        : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    createGuestInvitation: (workspace, input) => {
      expect(workspace).toBe(IDS.workspace);
      requests.push(input);
      return Promise.resolve(made());
    },
  });
  try {
    const user = person();
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    await user.type(
      view.getByRole('textbox', { name: 'Guest email address' }),
      'Partner@example.test',
    );
    await user.click(await view.findByRole('checkbox', { name: '#api' }));
    await user.selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'never');
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await view.findByText('Guest invitation created.');
    expect(requests).toEqual([
      { email: 'partner@example.test', channelIds: [IDS.api], accessExpiresAt: null, locale: 'en' },
    ]);
    const link = view.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement;
    expect(link.value.endsWith('/invite#' + 'a'.repeat(64))).toBe(true);
    await view.findByText('The invitation was created, but the lists could not be refreshed.');
    expect(view.queryByText('Guest invitation created.') !== null).toBe(true);
    await expectNoAxeViolations(view.container);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});

test('an invitation refusal preserves the address and selected conversation for retry', async () => {
  let calls = 0;
  const view = await open({
    createGuestInvitation: () => {
      calls += 1;
      return Promise.reject(new ApiError(409, 'PEERS_BEHIND', 'Deployment not ready'));
    },
  });
  try {
    const user = person();
    await user.click(await view.findByRole('button', { name: 'Invite a guest' }));
    const email = view.getByRole('textbox', { name: 'Guest email address' }) as HTMLInputElement;
    await user.type(email, 'partner@example.test');
    const channel = await view.findByRole('checkbox', { name: '#api' });
    await user.click(channel);
    await user.click(view.getByRole('button', { name: 'Create guest invitation' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(email.value).toBe('partner@example.test');
    expect((channel as HTMLInputElement).checked).toBe(true);
    expect(view.queryByRole('textbox', { name: 'Invitation link' }) === null).toBe(true);
  } finally {
    view.unmount();
    view.world.client.clear();
  }
});
