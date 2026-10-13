/**
 * Workspace settings (D-124): an owner's or an admin's, the name changed everywhere in the tab at
 * once, the address said and kept, and a refusal that keeps what was typed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { UserRole } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, WORKSPACE, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
      ...api,
    }),
  });
  await settle();
  await person().click(view.getByRole('button', { name: 'Switch workspace' }));
  return view;
};

describe('workspace settings', () => {
  test('are an owner’s and an admin’s; a member is not offered them', async () => {
    const member = await open({}, 'member');
    expect(member.queryByRole('menuitem', { name: 'Workspace settings…' })).toBeNull();
    member.unmount();
    const admin = await open({}, 'admin');
    expect(admin.getByRole('menuitem', { name: 'Workspace settings…' })).toBeDefined();
    admin.unmount();
  });

  test('a new name is saved, and shows in the sidebar at once; the address is said and kept', async () => {
    const asked: [string, string][] = [];
    const view = await open({
      renameWorkspace: (workspaceId, name) => {
        asked.push([workspaceId, name]);
        return Promise.resolve({ ...WORKSPACE, name });
      },
    });
    await person().click(view.getByRole('menuitem', { name: 'Workspace settings…' }));
    const dialog = view.getByRole('dialog', { name: 'Workspace settings' });
    expect(dialog.textContent).toContain(`/w/${WORKSPACE.slug}`);
    await expectNoAxeViolations(dialog);
    const field = within(dialog).getByLabelText('Name');
    expect((field as HTMLInputElement).value).toBe(WORKSPACE.name);
    await person().clear(field);
    await person().type(field, '  Acme Platform ');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(asked).toEqual([[WORKSPACE.id, 'Acme Platform']]);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(within(view.getByRole('complementary')).getByText('Acme Platform')).toBeDefined();
    view.unmount();
  });

  test('a blank name is not sent; a refusal says why and keeps what was typed', async () => {
    let calls = 0;
    const view = await open({
      renameWorkspace: () => {
        calls += 1;
        return Promise.reject(new ApiError(500, 'INTERNAL', 'no'));
      },
    });
    await person().click(view.getByRole('menuitem', { name: 'Workspace settings…' }));
    const dialog = view.getByRole('dialog', { name: 'Workspace settings' });
    const field = within(dialog).getByLabelText('Name');
    await person().clear(field);
    await person().type(field, '   ');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(dialog.textContent).toContain('A workspace needs a name.');
    expect(calls).toBe(0);
    await person().clear(field);
    await person().type(field, 'Kept');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(calls).toBe(1);
    expect(dialog.textContent).toContain('The name was not changed.');
    expect((field as HTMLInputElement).value).toBe('Kept');
    view.unmount();
  });
});
