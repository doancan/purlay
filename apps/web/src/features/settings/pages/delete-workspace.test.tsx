/**
 * Deleting the workspace (D-242), through the real frame at General's address: an owner's alone; the
 * dialog says what goes and when, leads to an export first, and does nothing until the name is typed;
 * asked, the workspace leaves the tab and the front door takes over; refused, it says why and keeps what
 * was typed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { WORKSPACE_DELETION_GRACE_DAYS, type MeResponse, type UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { WORKSPACE, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const openPage = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
  me: () => MeResponse = aSession,
): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/general',
    api: aSignedInApi({
      me: () => {
        const session = me();
        return Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        });
      },
      ...api,
    }),
  });
  await settle();
  await view.findByRole('heading', { level: 1, name: 'General' });
  return view;
};

const ENTRY = 'Delete workspace…';

const openDialog = async (view: View): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: ENTRY }));
  return await view.findByRole('dialog');
};

describe('deleting the workspace', () => {
  test('is an owner’s alone: an admin sees General without it', async () => {
    const admin = await openPage({}, 'admin');
    expect(admin.queryByRole('button', { name: ENTRY })).toBeNull();
    admin.unmount();
    const owner = await openPage({});
    expect(owner.getByRole('button', { name: ENTRY })).toBeDefined();
    owner.unmount();
  });

  test('the dialog says when, leads to an export, and waits for the name; typed, the workspace is asked for and left', async () => {
    const asked: [string, string][] = [];
    let deleted = false;
    const view = await openPage(
      {
        requestWorkspaceDeletion: (workspaceId, confirm) => {
          asked.push([workspaceId, confirm]);
          deleted = true;
          return Promise.resolve({
            workspace: WORKSPACE,
            purgeAt: '2026-11-08T09:00:00.000Z',
          });
        },
      },
      'owner',
      // Read again after asking: gone from the memberships, listed to be kept.
      () =>
        deleted
          ? {
              ...aSession(),
              memberships: [],
              scheduledDeletions: [{ workspace: WORKSPACE, purgeAt: '2026-11-08T09:00:00.000Z' }],
            }
          : aSession(),
    );
    const dialog = await openDialog(view);
    expect(dialog.textContent).toContain(`After ${String(WORKSPACE_DELETION_GRACE_DAYS)} days`);
    const exports = within(dialog).getByRole('link', { name: 'Go to exports' });
    expect(exports.getAttribute('href')).toBe('/w/acme/settings/data');
    await expectNoAxeViolations(dialog);
    const submit = within(dialog).getByRole('button', { name: 'Delete workspace' });
    const field = within(dialog).getByLabelText(
      `Type the workspace’s name, ${WORKSPACE.name}, to confirm`,
    );
    expect(submit).toHaveProperty('disabled', true);
    await person().type(field, WORKSPACE.name.slice(0, -1));
    expect(submit).toHaveProperty('disabled', true);
    await person().type(field, WORKSPACE.name.slice(-1));
    expect(submit).toHaveProperty('disabled', false);
    await person().click(submit);
    await settle();
    expect(asked).toEqual([[WORKSPACE.id, WORKSPACE.name]]);
    // The front door, with the way to keep it.
    expect(await view.findByRole('button', { name: `Keep ${WORKSPACE.name}` })).toBeDefined();
    view.unmount();
  });

  test('refused for its name, it says so under the field; refused otherwise, above the buttons — and what was typed stays', async () => {
    const failures = [
      new ApiError(400, 'VALIDATION_FAILED', 'no', { confirm: 'is not the workspace’s name' }),
      new ApiError(500, 'INTERNAL', 'no'),
    ];
    const view = await openPage({
      requestWorkspaceDeletion: () => Promise.reject(failures.shift() ?? new Error('no more')),
    });
    const dialog = await openDialog(view);
    const field = within(dialog).getByLabelText<HTMLInputElement>(
      `Type the workspace’s name, ${WORKSPACE.name}, to confirm`,
    );
    await person().type(field, WORKSPACE.name);
    const submit = within(dialog).getByRole('button', { name: 'Delete workspace' });
    await person().click(submit);
    await settle();
    expect(dialog.textContent).toContain('That is not the workspace’s name.');
    expect(field.value).toBe(WORKSPACE.name);
    await person().click(submit);
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'The workspace was not deleted.',
    );
    expect(field.value).toBe(WORKSPACE.name);
    // Closed, it forgets.
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    const again = await openDialog(view);
    expect(
      within(again).getByLabelText<HTMLInputElement>(
        `Type the workspace’s name, ${WORKSPACE.name}, to confirm`,
      ).value,
    ).toBe('');
    view.unmount();
  });
});
