/** Guest management through the real settings frame: scope, expiry, recovery, paging and revocation. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import {
  PAGE_LIMIT,
  type UpdatedGuestAccess,
  type WorkspaceGuest,
  type WorkspaceGuestPage,
} from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  ME,
  IDS,
  WHEN,
  NO_PROFILE,
  aSession,
  aChannel,
  aSignedInApi,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { systemClock } from '../../system-clock';
import { keys } from '../../data/keys';

installDom();
const opened: Awaited<ReturnType<typeof renderApp>>[] = [];
afterEach(() => {
  for (const view of opened) view.unmount();
  opened.length = 0;
});

const aGuest = (over: Partial<WorkspaceGuest> = {}): WorkspaceGuest => ({
  user: ALICE,
  joinedAt: WHEN,
  access: { kind: 'guest', historySince: WHEN, expiresAt: null },
  channelIds: [IDS.api],
  hiddenChannelCount: 1,
  ...over,
});
const aPage = (...data: WorkspaceGuest[]): WorkspaceGuestPage => ({ data, nextCursor: null });
const team = (): Awaited<ReturnType<Api['members']>> => [
  { user: ME, role: 'owner', joinedAt: WHEN, profile: NO_PROFILE },
  { user: ALICE, role: 'member', joinedAt: WHEN, profile: NO_PROFILE, accessKind: 'guest' },
  { user: BOB, role: 'member', joinedAt: WHEN, profile: NO_PROFILE },
];
const open = async (api: Partial<Api> = {}): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/members',
    api: aSignedInApi({
      members: () => Promise.resolve(team()),
      guests: () => Promise.resolve(aPage(aGuest())),
      ...api,
    }),
  });
  opened.push(view);
  await view.findByRole('heading', { level: 1, name: 'Members' });
  return view;
};
const guestView = async (
  api: Partial<Api> = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await open(api);
  await person().click(view.getByRole('button', { name: 'Guests' }));
  await view.findByRole('heading', { level: 2, name: 'Guests' });
  return view;
};

describe('restricted guest administration', () => {
  test('full membership requires an acknowledgment and preserves the accepted receipt after a failed refresh', async () => {
    let reads = 0;
    let memberReads = 0;
    const calls: unknown[] = [];
    const view = await guestView({
      members: () =>
        ++memberReads === 1
          ? Promise.resolve(team())
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      guests: () =>
        ++reads === 1
          ? Promise.resolve(aPage(aGuest()))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      convertGuest: (_workspace, _user, input) => {
        calls.push(input);
        return Promise.resolve({
          user: ALICE,
          role: 'member',
          joinedAt: WHEN,
          profile: NO_PROFILE,
        });
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Make full member: ${ALICE.displayName}` }),
    );
    expect(view.getByRole('button', { name: 'Cancel' }) === document.activeElement).toBe(true);
    expect(
      view.getByText(/They will gain access to public workspace channels/).textContent,
    ).toContain('earlier messages and files');
    expect(
      (view.getByRole('button', { name: 'Confirm full membership' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await person().click(view.getByRole('button', { name: 'Confirm full membership' }));
    expect(calls).toEqual([]);
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    expect(
      view.getByRole('button', { name: `Make full member: ${ALICE.displayName}` }) ===
        document.activeElement,
    ).toBe(true);
    await person().click(
      view.getByRole('button', { name: `Make full member: ${ALICE.displayName}` }),
    );
    await person().click(
      view.getByRole('checkbox', {
        name: 'I understand that this expands their access to earlier content.',
      }),
    );
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: 'Confirm full membership' }));
    await view.findByText(
      'Full membership saved. The list could not be refreshed. Retry to load current members.',
    );
    expect(calls).toEqual([{ confirmFullAccess: true }]);
    expect(memberReads).toBe(2);
    expect(
      view.queryByRole('button', { name: `Manage access for ${ALICE.displayName}` }) === null,
    ).toBe(true);
    expect(view.getByRole('textbox', { name: 'Find a guest' }) === document.activeElement).toBe(
      true,
    );
    await person().click(view.getByRole('button', { name: 'Members' }));
    expect(
      (view.getByRole('combobox', { name: `Role of ${ALICE.displayName}` }) as HTMLSelectElement)
        .value,
    ).toBe('member');
  });

  test('a lost conversion answer refreshes authority and keeps an explicit result when the row has already gone', async () => {
    let reads = 0;
    const view = await guestView({
      guests: () => Promise.resolve(++reads === 1 ? aPage(aGuest()) : aPage()),
      convertGuest: () => Promise.reject(new ApiError(0, 'NETWORK', 'answer lost')),
    });
    await person().click(
      await view.findByRole('button', { name: `Make full member: ${ALICE.displayName}` }),
    );
    await person().click(
      view.getByRole('checkbox', {
        name: 'I understand that this expands their access to earlier content.',
      }),
    );
    await person().click(view.getByRole('button', { name: 'Confirm full membership' }));
    await view.findByText(/The result could not be confirmed/);
    expect(reads).toBe(2);
    expect(view.getByRole('textbox', { name: 'Find a guest' }) === document.activeElement).toBe(
      true,
    );
    expect(view.queryByRole('combobox', { name: `Role of ${ALICE.displayName}` }) === null).toBe(
      true,
    );
  });

  test('a lost conversion answer with an unchanged guest keeps its acknowledgment and does not move focus to a removed-row recovery', async () => {
    let reads = 0;
    const view = await guestView({
      guests: () => {
        reads += 1;
        return Promise.resolve(aPage(aGuest()));
      },
      convertGuest: () => Promise.reject(new ApiError(0, 'NETWORK', 'answer lost')),
    });
    await person().click(
      await view.findByRole('button', { name: `Make full member: ${ALICE.displayName}` }),
    );
    const acknowledgment = view.getByRole('checkbox', {
      name: 'I understand that this expands their access to earlier content.',
    }) as HTMLInputElement;
    await person().click(acknowledgment);
    await person().click(view.getByRole('button', { name: 'Confirm full membership' }));
    await view.findByRole('alert');
    expect(reads).toBe(2);
    expect(acknowledgment.checked).toBe(true);
    expect(view.getAllByText(/The result could not be confirmed/)).toHaveLength(1);
    expect(view.getByRole('alert').textContent).toContain('The result could not be confirmed');
    expect(view.getByRole('textbox', { name: 'Find a guest' }) === document.activeElement).toBe(
      false,
    );
    expect(view.getByText(/The guest access end date is removed/).textContent).toContain(
      'earlier messages and files',
    );
  });
  test('a refused conversion preserves acknowledgment and does not invent full membership', async () => {
    const view = await guestView({
      convertGuest: () =>
        Promise.reject(new ApiError(403, 'FORBIDDEN', 'No longer an administrator.')),
    });
    await person().click(
      await view.findByRole('button', { name: `Make full member: ${ALICE.displayName}` }),
    );
    const acknowledgment = view.getByRole('checkbox', {
      name: 'I understand that this expands their access to earlier content.',
    }) as HTMLInputElement;
    await person().click(acknowledgment);
    await person().click(view.getByRole('button', { name: 'Confirm full membership' }));
    await view.findByRole('alert');
    expect(acknowledgment.checked).toBe(true);
    expect(
      view.world.client.getQueryData<{ pages: WorkspaceGuestPage[] }>(
        keys.guests(IDS.workspace, ''),
      )?.pages[0]?.data[0]?.access.kind,
    ).toBe('guest');
  });

  test('normal member roles exclude guests, and guest mode has named scope, hidden count and no promotion control', async () => {
    const view = await open();
    expect(
      within(view.getByRole('list', { name: 'Members' })).queryByText(ALICE.displayName) === null,
    ).toBe(true);
    expect(view.queryByRole('combobox', { name: `Role of ${ALICE.displayName}` }) === null).toBe(
      true,
    );
    expect(view.getByRole('combobox', { name: `Role of ${BOB.displayName}` })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Guests' }));
    const list = await view.findByRole('list', { name: 'Guests' });
    const row = within(list).getByRole('listitem');
    expect(row.textContent).toContain(ALICE.displayName);
    expect(row.textContent).toContain('#api');
    expect(row.textContent).toContain('1 hidden or unavailable channel');
    expect(view.queryByRole('combobox', { name: `Role of ${ALICE.displayName}` }) === null).toBe(
      true,
    );
    expect(view.queryByRole('link', { name: /Invite people/ }) === null).toBe(true);
    await expectNoAxeViolations(view.container);
  });

  test('a workspace without chat offers no guest view and asks for no guest data', async () => {
    let calls = 0;
    const session = aSession();
    const view = await open({
      me: () =>
        Promise.resolve({
          ...session,
          modules: [],
          memberships: session.memberships.map((m) => ({ ...m, modules: [] })),
        }),
      guests: () => {
        calls += 1;
        return Promise.resolve(aPage());
      },
    });
    expect(view.queryByRole('button', { name: 'Guests' }) === null).toBe(true);
    expect(calls).toBe(0);
    const members = within(view.getByRole('list', { name: 'Members' }));
    expect(members.getByText(ALICE.displayName).textContent).toContain(ALICE.displayName);
    expect(members.queryByRole('combobox', { name: `Role of ${ALICE.displayName}` }) === null).toBe(
      true,
    );
    expect(
      members.getByRole('button', { name: `Remove ${ALICE.displayName}` }).textContent,
    ).toContain('Remove');
  });

  test('a failed directory read can be retried without replacing it with a false empty state', async () => {
    let calls = 0;
    const view = await guestView({
      guests: () =>
        ++calls === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(aPage(aGuest())),
    });
    await view.findByText('Guest access could not be loaded.');
    expect(view.queryByText('No guests match this search.') === null).toBe(true);
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` });
  });

  test('held edits serialize controls and keep an accepted receipt when the subsequent read fails', async () => {
    let reads = 0;
    const requests: unknown[] = [];
    const pending = Promise.withResolvers<UpdatedGuestAccess>();
    const view = await guestView({
      guests: () =>
        ++reads === 1
          ? Promise.resolve(aPage(aGuest()))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return pending.promise;
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    const box = view.getByRole('checkbox', { name: '#api' }) as HTMLInputElement;
    await person().click(box);
    const save = view.getByRole('button', { name: 'Save access' });
    act(() => {
      save.click();
      save.click();
    });
    expect(requests).toEqual([{ channelIds: [] }]);
    expect((view.getByRole('button', { name: 'Save access' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await person().click(box);
    expect(box.checked).toBe(false);
    await act(async () => {
      pending.resolve({
        joinedAt: WHEN,
        access: aGuest().access,
        channelIds: [],
        hiddenChannelCount: 1,
      });
      await Promise.resolve();
    });
    await view.findByText(
      'Access saved. The list could not be refreshed. Retry to load the latest access.',
    );
    expect(view.getByRole('button', { name: 'Retry' }) === document.activeElement).toBe(true);
    const row = within(view.getByRole('list', { name: 'Guests' })).getByRole('listitem');
    expect(row.textContent).toContain('No visible channels');
    expect(row.textContent).toContain('1 hidden or unavailable channel');
  });

  test('scope-only edits of an expired guest omit expiry, and refusal preserves the draft', async () => {
    const expired = aGuest({
      joinedAt: '2000-01-01T00:00:00.000Z',
      access: {
        kind: 'guest',
        historySince: '2000-01-01T00:00:00.000Z',
        expiresAt: '2001-01-01T00:00:00.000Z',
      },
    });
    const requests: unknown[] = [];
    const view = await guestView({
      guests: () => Promise.resolve(aPage(expired)),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return Promise.reject(
          new ApiError(400, 'VALIDATION_FAILED', 'Refresh the scope.', {
            channelIds: 'Refresh the scope.',
          }),
        );
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText('Refresh the scope.');
    expect(requests).toEqual([{ channelIds: [] }]);
    expect((view.getByRole('checkbox', { name: '#api' }) as HTMLInputElement).checked).toBe(false);
    expect((view.getByRole('combobox', { name: 'Access expiry' }) as HTMLSelectElement).value).toBe(
      'keep',
    );
  });

  test('an explicit no-end choice sends null without replacing channels or recovering old admission history', async () => {
    const expired = aGuest({
      joinedAt: '2000-01-01T00:00:00.000Z',
      access: {
        kind: 'guest',
        historySince: '2000-01-01T00:00:00.000Z',
        expiresAt: '2001-01-01T00:00:00.000Z',
      },
    });
    const requests: unknown[] = [];
    const view = await guestView({
      guests: () => Promise.resolve(aPage(expired)),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return Promise.resolve({
          joinedAt: WHEN,
          access: aGuest().access,
          channelIds: [IDS.api],
          hiddenChannelCount: 1,
        });
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'never');
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText('Guest access saved.');
    expect(requests).toEqual([{ accessExpiresAt: null }]);
  });

  test('search and older pages use server filters and append without duplicate guests', async () => {
    const calls: unknown[] = [];
    const view = await guestView({
      guests: (_workspace, query) => {
        calls.push(query);
        return Promise.resolve(
          query.before === undefined
            ? { data: [aGuest()], nextCursor: ALICE.id }
            : aPage(aGuest(), aGuest({ user: BOB })),
        );
      },
    });
    await person().click(await view.findByRole('button', { name: 'Load older guests' }));
    await view.findByRole('button', { name: `Manage access for ${BOB.displayName}` });
    expect(
      within(view.getByRole('list', { name: 'Guests' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(calls).toEqual([{}, { before: ALICE.id }]);
    const search = view.getByRole('textbox', { name: 'Find a guest' });
    await person().type(search, '50%_ Görkem');
    await person().click(view.getByRole('button', { name: 'Search guests' }));
    expect(calls.at(-1)).toEqual({ q: '50%_ Görkem' });
  });

  test('removal requires confirmation and the accepted removal survives a failed refresh', async () => {
    let reads = 0;
    const removed: string[] = [];
    const view = await guestView({
      guests: () =>
        ++reads === 1
          ? Promise.resolve(aPage(aGuest()))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      removeMember: (_workspace, userId) => {
        removed.push(userId);
        return Promise.resolve();
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Remove guest ${ALICE.displayName}` }),
    );
    expect(removed).toEqual([]);
    expect(view.getByRole('button', { name: 'Cancel' }) === document.activeElement).toBe(true);
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    expect(removed).toEqual([]);
    await person().click(view.getByRole('button', { name: `Remove guest ${ALICE.displayName}` }));
    await person().click(view.getByRole('button', { name: 'Remove guest' }));
    await view.findByText('Guest removed. The list could not be refreshed.');
    expect(removed).toEqual([ALICE.id]);
    expect(
      view.queryByRole('button', { name: `Manage access for ${ALICE.displayName}` }) === null,
    ).toBe(true);
    expect(view.getByRole('textbox', { name: 'Find a guest' }) === document.activeElement).toBe(
      true,
    );
  });

  test('an observed concurrent access change keeps the draft and requires an explicit reload', async () => {
    const view = await guestView();
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'never');
    act(() => {
      view.world.client.setQueryData(keys.guests(IDS.workspace, ''), {
        pages: [aPage(aGuest({ channelIds: [IDS.deploys] }))],
        pageParams: [undefined],
      });
    });
    await view.findByText(
      'Guest access changed while this form was open. Your draft is kept; reload access before saving.',
    );
    expect((view.getByRole('combobox', { name: 'Access expiry' }) as HTMLSelectElement).value).toBe(
      'never',
    );
    expect((view.getByRole('button', { name: 'Save access' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await person().click(view.getByRole('button', { name: 'Reload access' }));
    expect((view.getByRole('checkbox', { name: '#api' }) as HTMLInputElement).checked).toBe(false);
    expect((view.getByRole('checkbox', { name: '#deploys' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((view.getByRole('combobox', { name: 'Access expiry' }) as HTMLSelectElement).value).toBe(
      'keep',
    );
  });

  test('custom expiry validates date and time, uses the shown device zone and sends only the chosen access end', async () => {
    const clock = spyOn(systemClock, 'now').mockReturnValue(new Date('2026-09-09T12:00:00.000Z'));
    const requests: unknown[] = [];
    let current = aGuest();
    try {
      const view = await guestView({
        guests: () => Promise.resolve(aPage(current)),
        updateGuestAccess: (_workspace, _user, input) => {
          requests.push(input);
          current = {
            ...current,
            access: { ...current.access, expiresAt: input.accessExpiresAt ?? null },
          };
          return Promise.resolve({
            joinedAt: current.joinedAt,
            access: current.access,
            channelIds: current.channelIds,
            hiddenChannelCount: current.hiddenChannelCount,
          });
        },
      });
      await person().click(
        await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
      );
      await person().selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'date');
      await person().click(view.getByLabelText('Access end date'));
      await person().click(view.getByRole('button', { name: 'September 10, 2026' }));
      await person().click(view.getByRole('button', { name: 'Save access' }));
      await view.findByText('Choose a valid future date and time.');
      expect(requests).toEqual([]);
      await person().type(view.getByLabelText('Access end time'), '14:30');
      await person().click(view.getByLabelText('Access end date'));
      await person().click(view.getByRole('button', { name: 'September 8, 2026' }));
      await person().click(view.getByRole('button', { name: 'Save access' }));
      expect(requests).toEqual([]);
      await view.findByText('Choose a valid future date and time.');
      await person().click(view.getByLabelText('Access end date'));
      await person().click(view.getByRole('button', { name: 'September 10, 2026' }));
      await expectNoAxeViolations(view.container);
      await person().click(view.getByRole('button', { name: 'Save access' }));
      await view.findByText('Guest access saved.');
      expect(requests).toEqual([
        { accessExpiresAt: new Date('2026-09-10T14:30:00').toISOString() },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test('channel paging and searching preserve an assignment outside the displayed page and exclude direct messages', async () => {
    const channels = Array.from({ length: PAGE_LIMIT.default + 1 }, (_, index) =>
      aChannel(
        `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
        `supplier-${String(index).padStart(3, '0')}`,
      ),
    );
    const last = channels.at(-1);
    if (last === undefined) throw new Error('Missing last channel fixture');
    const requests: unknown[] = [];
    const current = aGuest({ channelIds: [IDS.api, last.id] });
    const view = await guestView({
      channels: () =>
        Promise.resolve([
          aChannel(IDS.api, 'api'),
          ...channels,
          aChannel(IDS.dm, 'private-dm', { type: 'direct_message' }),
        ]),
      guests: () => Promise.resolve(aPage(current)),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return Promise.resolve(current);
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    expect(view.getAllByRole('checkbox')).toHaveLength(PAGE_LIMIT.default);
    expect(view.queryByRole('checkbox', { name: '#private-dm' }) === null).toBe(true);
    expect(view.queryByRole('checkbox', { name: `#${last.name ?? ''}` }) === null).toBe(true);
    await person().click(view.getByRole('button', { name: 'Show more channels' }));
    expect(view.queryByRole('checkbox', { name: '#private-dm' }) === null).toBe(true);
    expect(
      (view.getByRole('checkbox', { name: `#${last.name ?? ''}` }) as HTMLInputElement).checked,
    ).toBe(true);
    await person().type(view.getByRole('textbox', { name: 'Find a channel' }), 'api');
    expect(view.getAllByRole('checkbox')).toHaveLength(1);
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText('Guest access saved.');
    expect(requests).toEqual([{ channelIds: [last.id] }]);
  });

  test('hidden assignments count toward the limit and replacing one visible channel at the exact limit is allowed', async () => {
    const requests: unknown[] = [];
    const current = aGuest({ hiddenChannelCount: 19 });
    const view = await guestView({
      guests: () => Promise.resolve(aPage(current)),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return Promise.resolve(current);
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().click(view.getByRole('checkbox', { name: '#deploys' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    expect(requests).toEqual([]);
    const row = within(view.getByRole('list', { name: 'Guests' })).getByRole('listitem');
    expect(within(row).getByRole('alert').textContent).toContain('at most 20 channels');
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText('Guest access saved.');
    expect(requests).toEqual([{ channelIds: [IDS.deploys] }]);
  });

  test('a failed channel refresh preserves the selection but refuses saving it until the channel read recovers', async () => {
    let failing = false;
    const requests: unknown[] = [];
    const current = aGuest();
    const view = await guestView({
      channels: () =>
        failing
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve([aChannel(IDS.api, 'api')]),
      updateGuestAccess: (_workspace, _user, input) => {
        requests.push(input);
        return Promise.resolve(current);
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    failing = true;
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: keys.channels(IDS.workspace) });
    });
    await view.findByText('Channels could not be loaded. Retry before changing the selection.');
    await person().click(view.getByRole('button', { name: 'Save access' }));
    expect(requests).toEqual([]);
    expect((view.getByRole('checkbox', { name: '#api' }) as HTMLInputElement).checked).toBe(false);
    failing = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await Promise.resolve();
    });
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText('Guest access saved.');
    expect(requests).toEqual([{ channelIds: [] }]);
  });

  test('an unconfirmed write rereads authority, keeps the draft and requires reloading an observed change', async () => {
    let reads = 0;
    let writes = 0;
    const view = await guestView({
      guests: () =>
        Promise.resolve(aPage(++reads === 1 ? aGuest() : aGuest({ channelIds: [IDS.deploys] }))),
      updateGuestAccess: () => {
        writes += 1;
        return Promise.reject(new ApiError(0, 'NETWORK', 'connection lost'));
      },
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().selectOptions(view.getByRole('combobox', { name: 'Access expiry' }), 'never');
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText(/The result could not be confirmed/);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect((view.getByRole('combobox', { name: 'Access expiry' }) as HTMLSelectElement).value).toBe(
      'never',
    );
    expect((view.getByRole('button', { name: 'Save access' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await person().click(view.getByRole('button', { name: 'Reload access' }));
    expect((view.getByRole('checkbox', { name: '#deploys' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  test('leaving the guest view during a held save reconciles its cache without another abandoned directory read', async () => {
    let reads = 0;
    const pending = Promise.withResolvers<UpdatedGuestAccess>();
    const view = await guestView({
      guests: () => {
        reads += 1;
        return Promise.resolve(aPage(aGuest()));
      },
      updateGuestAccess: () => pending.promise,
    });
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await person().click(view.getByRole('button', { name: 'Members' }));
    await act(async () => {
      pending.resolve({
        joinedAt: WHEN,
        access: aGuest().access,
        channelIds: [],
        hiddenChannelCount: 1,
      });
      await pending.promise;
    });
    expect(reads).toBe(1);
    const cached = view.world.client.getQueryData<{
      readonly pages: readonly WorkspaceGuestPage[];
    }>(keys.guests(IDS.workspace, ''));
    expect(cached?.pages[0]?.data[0]?.channelIds).toEqual([]);
    expect(view.queryByText('Guest access saved.') === null).toBe(true);
  });

  test('an accepted receipt cancels an older search read and updates every cached search page without touching another workspace', async () => {
    let reads = 0;
    const view = await guestView({
      guests: () =>
        ++reads === 1
          ? Promise.resolve(aPage(aGuest()))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      updateGuestAccess: () =>
        Promise.resolve({
          joinedAt: WHEN,
          access: aGuest().access,
          channelIds: [],
          hiddenChannelCount: 1,
        }),
    });
    const snapshot = { pages: [aPage(aGuest())], pageParams: [undefined] };
    const otherSearch = keys.guests(IDS.workspace, 'older search');
    const otherWorkspace = keys.guests('another-workspace', 'older search');
    view.world.client.setQueryData(otherSearch, snapshot);
    view.world.client.setQueryData(otherWorkspace, snapshot);
    const delayed = Promise.withResolvers<typeof snapshot>();
    let started = 0;
    const oldRead = view.world.client
      .query({
        queryKey: otherSearch,
        staleTime: 0,
        queryFn: () => {
          started += 1;
          return delayed.promise;
        },
      })
      .catch(() => undefined);
    expect(started).toBe(1);
    expect(view.world.client.isFetching({ queryKey: otherSearch, exact: true })).toBe(1);
    await person().click(
      await view.findByRole('button', { name: `Manage access for ${ALICE.displayName}` }),
    );
    await person().click(view.getByRole('checkbox', { name: '#api' }));
    await person().click(view.getByRole('button', { name: 'Save access' }));
    await view.findByText(
      'Access saved. The list could not be refreshed. Retry to load the latest access.',
    );
    await act(async () => {
      delayed.resolve(snapshot);
      await oldRead;
    });
    expect(
      view.world.client.getQueryData<typeof snapshot>(otherSearch)?.pages[0]?.data[0]?.channelIds,
    ).toEqual([]);
    expect(
      view.world.client.getQueryData<typeof snapshot>(otherWorkspace)?.pages[0]?.data[0]
        ?.channelIds,
    ).toEqual([IDS.api]);
  });
});
