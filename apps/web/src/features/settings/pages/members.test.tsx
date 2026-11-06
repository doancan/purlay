/**
 * Members and roles (`ARCHITECTURE.md` §7.4, D-111, D-146), through the real frame at the Members
 * page's address: who is offered it, what an owner and an admin may change, removing someone after
 * asking, every failure said, and finding somebody by name, handle or role.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { UserRole, WorkspaceMember } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WHEN,
  aSession,
  aSignedInApi,
  NO_PROFILE,
} from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const team = (roles: Partial<Record<string, UserRole>> = {}): WorkspaceMember[] =>
  [ME, ALICE, BOB].map((user) => ({
    user,
    role: roles[user.username] ?? 'member',
    joinedAt: WHEN,
    profile: NO_PROFILE,
  }));

const render = async (path: string, api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path,
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            memberships: session.memberships.map((m) => ({ ...m, role })),
          }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

/** The Members page, loaded: its chunk is lazy, so the heading is waited for. */
const openPage = async (api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const view = await render('/w/acme/settings/members', api, role);
  await view.findByRole('heading', { level: 1, name: 'Members' });
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));

const roleOf = (view: View, name: string): HTMLSelectElement =>
  main(view).getByRole('combobox', { name: `Role of ${name}` });

/** The names in the list, in its order. */
const listed = (view: View): string[] =>
  within(main(view).getByRole('list', { name: 'Members' }))
    .getAllByRole('listitem')
    .map((row) => /@[a-z]+/.exec(row.textContent)?.[0] ?? '');

const count = (view: View, label: string): string =>
  main(view).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

describe('members and roles', () => {
  test('parallel role receipts preserve both changed rows when their refreshes fail', async () => {
    const resolvers = new Map<string, (member: WorkspaceMember) => void>();
    let reads = 0;
    const view = await openPage({
      members: () =>
        ++reads === 1
          ? Promise.resolve(team({ dogancan: 'owner' }))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      updateMemberRole: (_workspace, userId) =>
        new Promise((resolve) => {
          resolvers.set(userId, resolve);
        }),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'admin');
    await person().selectOptions(roleOf(view, BOB.displayName), 'admin');
    expect(resolvers.size).toBe(2);
    await act(async () => {
      for (const user of [BOB, ALICE]) {
        const resolve = resolvers.get(user.id);
        if (resolve === undefined) throw new Error('Expected a pending role change');
        resolve({ user, role: 'admin', joinedAt: WHEN, profile: NO_PROFILE });
      }
      await Promise.resolve();
    });
    await settle();
    expect(roleOf(view, ALICE.displayName)).toHaveProperty('value', 'admin');
    expect(roleOf(view, BOB.displayName)).toHaveProperty('value', 'admin');
    expect(count(view, 'Admins')).toBe('2');
    expect(count(view, 'Total')).toBe('3');
    view.unmount();
  });
  test('a confirmed self-demotion removes owner controls even if me and member refreshes fail', async () => {
    let reads = 0;
    let meReads = 0;
    const view = await openPage({
      me: () =>
        ++meReads === 1
          ? Promise.resolve(aSession())
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      members: () =>
        ++reads === 1
          ? Promise.resolve(team({ dogancan: 'owner', alice: 'owner' }))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      updateMemberRole: (_workspace, _user, role) =>
        Promise.resolve({ user: ME, role, joinedAt: WHEN, profile: NO_PROFILE }),
    });
    await person().selectOptions(roleOf(view, ME.displayName), 'admin');
    await person().click(main(view).getByRole('button', { name: 'Change my role' }));
    await settle();
    expect(view.queryByRole('link', { name: 'Data & retention' })).toBeNull();
    expect(main(view).queryByRole('combobox', { name: `Role of ${ALICE.displayName}` })).toBeNull();
    expect(roleOf(view, ME.displayName)).toHaveProperty('value', 'admin');
    view.unmount();
  });
  test('an old pending read cannot restore a removed member after its successful receipt', async () => {
    let reads = 0;
    let stale: (members: WorkspaceMember[]) => void = () => undefined;
    const initial = team({ dogancan: 'owner' });
    const view = await openPage({
      members: () =>
        ++reads === 1
          ? Promise.resolve(initial)
          : reads === 2
            ? new Promise((resolve) => {
                stale = resolve;
              })
            : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      removeMember: () => Promise.resolve(),
    });
    void view.world.client.invalidateQueries({ queryKey: keys.members(IDS.workspace) });
    await settle();
    await person().click(main(view).getByRole('button', { name: `Remove ${ALICE.displayName}` }));
    await person().click(main(view).getByRole('button', { name: 'Remove' }));
    await settle();
    await act(async () => {
      stale(initial);
      await Promise.resolve();
    });
    expect(count(view, 'Total')).toBe('2');
    expect(listed(view)).not.toContain('@alice');
    view.unmount();
  });
  test('accepted removal updates the member count and remains visible when rereading fails', async () => {
    let reads = 0;
    const view = await openPage({
      members: () =>
        ++reads === 1
          ? Promise.resolve(team())
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      removeMember: () => Promise.resolve(),
    });
    await person().click(main(view).getByRole('button', { name: `Remove ${ALICE.displayName}` }));
    const row = within(main(view).getByRole('list', { name: 'Members' }))
      .getAllByRole('listitem')
      .find((item) => item.textContent.includes(`@${ALICE.username}`));
    if (row === undefined) throw new Error('Alice row missing');
    await person().click(within(row).getByRole('button', { name: 'Remove' }));
    expect(await view.findByText(`${ALICE.displayName} was removed.`)).toBeDefined();
    expect(await main(view).findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(count(view, 'Total')).toBe('2');
    expect(listed(view)).not.toContain(`@${ALICE.username}`);
    expect(roleOf(view, BOB.displayName)).toHaveProperty('disabled', true);
    view.unmount();
  });
  test('an accepted role reply survives a failed refresh without enabling stale controls', async () => {
    let reads = 0;
    const updated: WorkspaceMember = {
      user: ALICE,
      role: 'admin',
      joinedAt: WHEN,
      profile: NO_PROFILE,
    };
    const view = await openPage({
      members: () =>
        ++reads === 1
          ? Promise.resolve(team())
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      updateMemberRole: () => Promise.resolve(updated),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'admin');
    expect(await view.findByText(`${ALICE.displayName} is now Admin.`)).toBeDefined();
    expect(await main(view).findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(roleOf(view, ALICE.displayName).value).toBe('admin');
    expect(count(view, 'Admins')).toBe('1');
    expect(roleOf(view, ALICE.displayName)).toHaveProperty('disabled', true);
    view.unmount();
  });
  test('are an owner’s and an admin’s; a member is not offered them, and their address is not found', async () => {
    const member = await render('/w/acme/settings/members', {}, 'member');
    expect(await member.findByText('Nothing here')).toBeDefined();
    expect(member.queryByRole('link', { name: 'Members' })).toBeNull();
    member.unmount();
    const admin = await openPage({}, 'admin');
    expect(admin.getByRole('link', { name: 'Members' }).getAttribute('aria-current')).toBe('page');
  });

  test('an owner changes a role, the change is sent and the list read again; their own row has no Remove', async () => {
    let members = team({ dogancan: 'owner' });
    const sent: string[] = [];
    const view = await openPage({
      members: () => Promise.resolve(members),
      updateMemberRole: (workspaceId, userId, role) => {
        sent.push(`${workspaceId}/${userId}:${role}`);
        members = members.map((m) => (m.user.id === userId ? { ...m, role } : m));
        return Promise.resolve({ user: ALICE, role, joinedAt: WHEN, profile: NO_PROFILE });
      },
    });
    // Their own role is theirs to change (D-111), but removing themself is leaving, done elsewhere.
    expect(roleOf(view, ME.displayName)).toBeDefined();
    expect(main(view).queryByRole('button', { name: `Remove ${ME.displayName}` })).toBeNull();
    const alice = roleOf(view, ALICE.displayName);
    expect([...alice.options].map((option) => option.textContent)).toEqual([
      'Owner',
      'Admin',
      'Member',
    ]);
    await person().selectOptions(alice, 'admin');
    await settle();
    expect(sent).toEqual([`${IDS.workspace}/${ALICE.id}:admin`]);
    expect(roleOf(view, ALICE.displayName).value).toBe('admin');
  });

  test('an owner steps down from their own row, after saying so there; Cancel sends nothing (D-111)', async () => {
    let members = team({ dogancan: 'owner', alice: 'owner' });
    const sent: string[] = [];
    let asksForMe = 0;
    const session = aSession();
    const view = await openPage({
      me: () => {
        asksForMe += 1;
        return Promise.resolve(session);
      },
      members: () => Promise.resolve(members),
      updateMemberRole: (_workspaceId, userId, role) => {
        sent.push(`${userId}:${role}`);
        members = members.map((m) => (m.user.id === userId ? { ...m, role } : m));
        return Promise.resolve({ user: ME, role, joinedAt: WHEN, profile: NO_PROFILE });
      },
    });
    const mine = (): HTMLSelectElement => roleOf(view, ME.displayName);
    await person().selectOptions(mine(), 'admin');
    // Asked in the row first: they may not be able to change it back themself.
    const ask = main(view).getByText(/Make yourself Admin\?/);
    expect(ask.textContent).toContain('Only another owner or admin can change it back.');
    expect(sent).toEqual([]);
    await person().click(main(view).getByRole('button', { name: 'Cancel' }));
    expect(main(view).queryByText(/Make yourself/)).toBeNull();
    expect(sent).toEqual([]);

    await person().selectOptions(mine(), 'admin');
    const before = asksForMe;
    await person().click(main(view).getByRole('button', { name: 'Change my role' }));
    await settle();
    expect(sent).toEqual([`${ME.id}:admin`]);
    // What they may open changed with their role: the session is read again.
    expect(asksForMe).toBeGreaterThan(before);
  });

  test('an admin may not touch an owner, nor make one', async () => {
    const view = await openPage(
      { members: () => Promise.resolve(team({ dogancan: 'admin', alice: 'owner' })) },
      'admin',
    );
    expect(main(view).queryByRole('combobox', { name: `Role of ${ALICE.displayName}` })).toBeNull();
    const aliceRow = within(main(view).getByRole('list', { name: 'Members' }))
      .getAllByRole('listitem')
      .find((row) => row.textContent.includes('@alice'));
    expect(aliceRow?.textContent).toContain('Owner');
    expect([...roleOf(view, BOB.displayName).options].map((option) => option.value)).toEqual([
      'admin',
      'member',
    ]);
  });

  test('removing someone asks first; Cancel keeps them, Remove takes them out and reads the list again', async () => {
    let members = team({ dogancan: 'owner' });
    const removed: string[] = [];
    const view = await openPage({
      members: () => Promise.resolve(members),
      removeMember: (workspaceId, userId) => {
        removed.push(`${workspaceId}/${userId}`);
        members = members.filter((m) => m.user.id !== userId);
        return Promise.resolve();
      },
    });
    const page = main(view);
    await person().click(page.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    expect(page.getByText(/lose every channel/)).toBeDefined();
    await person().click(page.getByRole('button', { name: 'Cancel' }));
    expect(removed).toEqual([]);
    expect(page.queryByText(/lose every channel/)).toBeNull();
    await person().click(page.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    await person().click(page.getByRole('button', { name: 'Remove' }));
    await settle();
    expect(removed).toEqual([`${IDS.workspace}/${BOB.id}`]);
    expect(page.queryByRole('button', { name: `Remove ${BOB.displayName}` })).toBeNull();
  });

  test('the last owner is said as such; any other failure in words, and the role shown is the one kept', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ dogancan: 'owner', alice: 'owner' })),
      updateMemberRole: () => Promise.reject(new ApiError(409, 'LAST_OWNER', 'last')),
      removeMember: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'member');
    await settle();
    expect(view.getByRole('alert').textContent).toContain('A workspace keeps at least one owner.');
    expect(roleOf(view, ALICE.displayName).value).toBe('owner');
    const page = main(view);
    await person().click(page.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    await person().click(page.getByRole('button', { name: 'Remove' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('could not confirm the result');
  });

  test('any other refusal of a role is said in words, and leaving the page lets it go', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ dogancan: 'owner' })),
      updateMemberRole: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'forbidden')),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'admin');
    await settle();
    expect(view.getByRole('alert').textContent).toContain('The role was not changed.');
    await person().click(view.getByRole('link', { name: 'General' }));
    await view.findByRole('heading', { level: 1, name: 'General' });
    await person().click(view.getByRole('link', { name: 'Members' }));
    await view.findByRole('heading', { level: 1, name: 'Members' });
    await settle();
    expect(main(view).queryByRole('alert')).toBeNull();
  });

  test('a list that will not load says why, with Retry; while it is read it is a status', async () => {
    let failing = true;
    const view = await openPage({
      members: async () => {
        if (failing) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(team({ dogancan: 'owner' }));
      },
    });
    failing = false;
    await person().click(main(view).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(roleOf(view, ALICE.displayName)).toBeDefined();
    view.unmount();
    const reading = await openPage({ members: () => new Promise(() => undefined) });
    expect(reading.getByRole('main').querySelector('[role="status"]')).not.toBeNull();
  });

  test('says how many there are of each role', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ dogancan: 'owner', alice: 'admin' })),
    });
    expect(count(view, 'Total')).toBe('3');
    expect(count(view, 'Owners')).toBe('1');
    expect(count(view, 'Admins')).toBe('1');
    expect(count(view, 'Members')).toBe('1');
  });

  test('lists owners first, then admins, then members; found by name or handle, in any case, and by role', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ bob: 'owner', alice: 'admin' })),
    });
    expect(listed(view)).toEqual(['@bob', '@alice', '@dogancan']);
    const search = main(view).getByRole('searchbox', { name: 'Search by name or handle' });
    await person().type(search, 'ALI');
    expect(listed(view)).toEqual(['@alice']);
    await person().type(search, '{Backspace}{Backspace}{Backspace}');
    expect(listed(view)).toHaveLength(3);
    await person().type(search, 'nobody');
    expect(main(view).getByText('Nobody matches.')).toBeDefined();
    await person().type(search, '{Backspace}'.repeat('nobody'.length));
    const filter = main(view).getByRole('combobox', { name: 'Role' });
    expect([...(filter as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      'Every role',
      'Owner',
      'Admin',
      'Member',
    ]);
    await person().selectOptions(filter, 'member');
    expect(listed(view)).toEqual(['@dogancan']);
    // The counts are of the whole workspace, not of what the filter shows.
    expect(count(view, 'Total')).toBe('3');
    await person().selectOptions(filter, 'all');
    expect(listed(view)).toHaveLength(3);
  });

  test('Invite people opens the Invitations page', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ dogancan: 'owner' })),
      invitations: () => Promise.resolve({ data: [], nextCursor: null }),
    });
    await person().click(main(view).getByRole('link', { name: 'Invite people' }));
    expect(await view.findByRole('heading', { level: 1, name: 'Invitations' })).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/invitations');
  });

  test('passes the accessibility audit', async () => {
    const view = await openPage({
      members: () => Promise.resolve(team({ dogancan: 'owner' })),
    });
    await expectNoAxeViolations(view.getByRole('main'));
  });
});
