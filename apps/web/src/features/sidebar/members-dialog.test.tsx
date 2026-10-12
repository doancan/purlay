/**
 * Members and roles (`ARCHITECTURE.md` §7.4, D-111), through the real frame: who is offered it, what
 * an owner and an admin may change, removing someone after asking, and every failure said.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { UserRole, WorkspaceMember } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, ME, WHEN, aSession, aSignedInApi } from '../../testing/fixtures';
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

const team = (roles: Partial<Record<string, UserRole>> = {}): WorkspaceMember[] =>
  [ME, ALICE, BOB].map((user) => ({
    user,
    role: roles[user.username] ?? 'member',
    joinedAt: WHEN,
  }));

const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path: `/w/acme/c/${IDS.api}`,
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
  await person().click(view.getByRole('button', { name: 'Switch workspace' }));
  return view;
};

const openDialog = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await open(api, role);
  await person().click(view.getByRole('menuitem', { name: 'Members…' }));
  await settle();
  return view;
};

const roleOf = (view: Awaited<ReturnType<typeof renderApp>>, name: string): HTMLSelectElement =>
  within(view.getByRole('dialog')).getByRole('combobox', { name: `Role of ${name}` });

describe('members and roles', () => {
  test('are an owner’s and an admin’s; a member is not offered them', async () => {
    const member = await open({}, 'member');
    expect(member.queryByRole('menuitem', { name: 'Members…' })).toBeNull();
    member.unmount();
    const admin = await open({}, 'admin');
    expect(admin.getByRole('menuitem', { name: 'Members…' })).toBeDefined();
  });

  test('an owner changes a role, the change is sent and the list read again; their own row is not theirs to change', async () => {
    let members = team({ dogancan: 'owner' });
    const sent: string[] = [];
    const view = await openDialog({
      members: () => Promise.resolve(members),
      updateMemberRole: (workspaceId, userId, role) => {
        sent.push(`${workspaceId}/${userId}:${role}`);
        members = members.map((m) => (m.user.id === userId ? { ...m, role } : m));
        return Promise.resolve({ user: ALICE, role, joinedAt: WHEN });
      },
    });
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.queryByRole('combobox', { name: `Role of ${ME.displayName}` })).toBeNull();
    const alice = roleOf(view, ALICE.displayName);
    expect([...alice.options].map((option) => option.textContent)).toEqual([
      'Member',
      'Admin',
      'Owner',
    ]);
    await person().selectOptions(alice, 'admin');
    await settle();
    expect(sent).toEqual([`${IDS.workspace}/${ALICE.id}:admin`]);
    expect(roleOf(view, ALICE.displayName).value).toBe('admin');
  });

  test('an admin may not touch an owner, nor make one', async () => {
    const view = await openDialog(
      { members: () => Promise.resolve(team({ dogancan: 'admin', alice: 'owner' })) },
      'admin',
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.queryByRole('combobox', { name: `Role of ${ALICE.displayName}` })).toBeNull();
    expect(dialog.getByText('Owner')).toBeDefined();
    expect([...roleOf(view, BOB.displayName).options].map((option) => option.value)).toEqual([
      'member',
      'admin',
    ]);
  });

  test('removing someone asks first; Cancel keeps them, Remove takes them out and reads the list again', async () => {
    let members = team({ dogancan: 'owner' });
    const removed: string[] = [];
    const view = await openDialog({
      members: () => Promise.resolve(members),
      removeMember: (workspaceId, userId) => {
        removed.push(`${workspaceId}/${userId}`);
        members = members.filter((m) => m.user.id !== userId);
        return Promise.resolve();
      },
    });
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    expect(dialog.getByText(/lose every channel/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(removed).toEqual([]);
    await person().click(dialog.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    await person().click(dialog.getByRole('button', { name: 'Remove' }));
    await settle();
    expect(removed).toEqual([`${IDS.workspace}/${BOB.id}`]);
    expect(dialog.queryByRole('button', { name: `Remove ${BOB.displayName}` })).toBeNull();
  });

  test('the last owner is said as such; any other failure in words, and the role shown is the one kept', async () => {
    const view = await openDialog({
      members: () => Promise.resolve(team({ dogancan: 'owner', alice: 'owner' })),
      updateMemberRole: () => Promise.reject(new ApiError(409, 'LAST_OWNER', 'last')),
      removeMember: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'member');
    await settle();
    expect(view.getByRole('alert').textContent).toContain('A workspace keeps at least one owner.');
    expect(roleOf(view, ALICE.displayName).value).toBe('owner');
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: `Remove ${BOB.displayName}` }));
    await person().click(dialog.getByRole('button', { name: 'Remove' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('was not removed');
  });

  test('any other refusal of a role is said in words, and closing the dialog lets it go', async () => {
    const view = await openDialog({
      members: () => Promise.resolve(team({ dogancan: 'owner' })),
      updateMemberRole: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().selectOptions(roleOf(view, ALICE.displayName), 'admin');
    await settle();
    expect(view.getByRole('alert').textContent).toContain('The role was not changed.');
    await person().keyboard('{Escape}');
    await settle();
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Members…' }));
    await settle();
    expect(within(view.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  test('a list that will not load says why, with Retry; while it is read it is a status', async () => {
    // The sidebar reads the same list: while it fails, it fails for both.
    let failing = true;
    const view = await openDialog({
      members: async () => {
        if (failing) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(team({ dogancan: 'owner' }));
      },
    });
    const dialog = within(view.getByRole('dialog'));
    failing = false;
    await person().click(dialog.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(roleOf(view, ALICE.displayName)).toBeDefined();
    view.unmount();
    const reading = await openDialog({ members: () => new Promise(() => undefined) });
    expect(reading.getByRole('dialog').querySelector('[role="status"]')).not.toBeNull();
  });

  test('passes the accessibility audit', async () => {
    const view = await openDialog({
      members: () => Promise.resolve(team({ dogancan: 'owner' })),
    });
    await expectNoAxeViolations(view.getByRole('dialog'));
  });
});
