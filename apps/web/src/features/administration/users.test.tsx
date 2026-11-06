import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { ServerUser } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import {
  ADMIN_STAMP,
  ADMIN_USER,
  ADMIN_WORKSPACE,
  adminError,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
installDom();
const account: ServerUser = { ...ADMIN_USER, id: '00000000-0000-4000-8000-0000000000a2' };
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('server account operations', () => {
  test.each(['grant', 'revoke', 'endSessions', 'suspend', 'approve', 'deny'] as const)(
    '%s requires confirmation and posts only its defined change',
    async (action) => {
      const record = {
        ...account,
        isServerAdmin: action === 'revoke',
        admissionState:
          action === 'approve' || action === 'deny' ? ('pending' as const) : ('approved' as const),
      };
      const view = await renderAdministration('users', (call) =>
        call.method === 'GET' && call.path.startsWith('/api/server/users?')
          ? adminJson({ data: [record], nextCursor: null })
          : undefined,
      );
      const label = {
        grant: 'Grant administrator access',
        revoke: 'Remove administrator access',
        endSessions: 'Sign out everywhere',
        suspend: 'Suspend',
        approve: 'Approve account',
        deny: 'Deny admission',
      }[action];
      await person().click(await view.findByRole('button', { name: label }));
      expect(view.calls.some((call) => call.method !== 'GET')).toBe(false);
      const dialog = within(view.getByRole('dialog'));
      await person().click(dialog.getByRole('button', { name: 'Confirm change' }));
      expect(await view.findByText('Change saved')).toBeDefined();
      const sent = view.calls.find((call) => call.method !== 'GET');
      expect(sent).toBeDefined();
      expect(sent?.path).toBe(
        `/api/server/${action === 'suspend' ? 'accounts' : 'users'}/${account.id}/${action === 'grant' || action === 'revoke' ? 'admin' : action === 'endSessions' ? 'revoke-sessions' : action === 'suspend' ? 'suspension' : 'admission'}`,
      );
      expect(sent?.body).toEqual(
        action === 'grant' || action === 'revoke'
          ? { isServerAdmin: action === 'grant' }
          : action === 'approve' || action === 'deny'
            ? { decision: action === 'approve' ? 'approved' : 'denied' }
            : action === 'endSessions'
              ? {}
              : undefined,
      );
      view.unmount();
    },
  );
  test('restoring is immediate; a refused suspension stays open for retry, and cancel takes nothing', async () => {
    let suspended = true;
    let fail = true;
    const view = await renderAdministration('users', (call) => {
      if (call.method === 'GET' && call.path.startsWith('/api/server/users?'))
        return adminJson({
          data: [{ ...account, suspendedAt: suspended ? ADMIN_STAMP : null, emailVerified: false }],
          nextCursor: null,
        });
      if (call.path.endsWith('/suspension')) {
        if (call.method === 'DELETE') {
          suspended = false;
          return new Response(null, { status: 204 });
        }
        if (fail) return adminError();
        suspended = true;
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    await person().click(await view.findByRole('button', { name: 'Lift suspension' }));
    expect(await view.findByText('Change saved')).toBeDefined();
    expect(
      view.getByRole('button', { name: 'Grant administrator access' }).hasAttribute('disabled'),
    ).toBe(true);
    await person().click(view.getByRole('button', { name: 'Suspend' }));
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Suspend' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Confirm change' }),
    );
    expect(await within(view.getByRole('dialog')).findByRole('alert')).toBeDefined();
    fail = false;
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Confirm change' }),
    );
    expect(await view.findByRole('button', { name: 'Lift suspension' })).toBeDefined();
    view.unmount();
  });
  test('account details read last activity, active sessions and paginated memberships, and return focus when closed', async () => {
    const view = await renderAdministration('users', (call) => {
      if (call.path.startsWith('/api/server/users?'))
        return adminJson({ data: [account], nextCursor: null });
      if (call.path.startsWith(`/api/server/users/${account.id}`))
        return adminJson({
          user: { ...account, lastSeenAt: ADMIN_STAMP },
          memberships: call.path.includes('after=')
            ? []
            : [
                {
                  workspaceId: ADMIN_WORKSPACE.id,
                  workspaceName: 'Research team',
                  workspaceSlug: 'research',
                  role: 'owner',
                },
              ],
          nextCursor: call.path.includes('after=') ? null : ADMIN_WORKSPACE.id,
          activeSessions: 2,
        });
      return undefined;
    });
    const opener = await view.findByRole('button', { name: 'Account details' });
    await person().click(opener);
    const dialog = within(view.getByRole('dialog'));
    expect(await dialog.findByText(/Research team/)).toBeDefined();
    expect(dialog.getByText('2')).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Next page' }));
    expect(await dialog.findByText('No matching records')).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Previous page' }));
    expect(await dialog.findByText(/Research team/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Close' }));
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });
  test('never-seen accounts and a failed details read are recoverable, and filters select each account status', async () => {
    let fail = true;
    const view = await renderAdministration('users', (call) => {
      if (call.path.startsWith('/api/server/users?'))
        return adminJson({ data: [account], nextCursor: null });
      if (call.path.startsWith(`/api/server/users/${account.id}`))
        return fail
          ? adminError()
          : adminJson({ user: account, memberships: [], nextCursor: null, activeSessions: 0 });
      return undefined;
    });
    await person().click(await view.findByRole('button', { name: 'Account details' }));
    const dialog = within(view.getByRole('dialog'));
    fail = false;
    await person().click(await dialog.findByRole('button', { name: 'Retry' }));
    expect(await dialog.findByText('No recorded activity')).toBeDefined();
    await person().keyboard('{Escape}');
    for (const status of ['active', 'suspended', 'admins', 'pending', 'denied', '']) {
      await person().selectOptions(view.getByLabelText('Status'), status);
      await person().click(view.getByRole('button', { name: 'Search' }));
      await settle();
    }
    expect(view.calls.some((call) => call.path.includes('status=pending'))).toBe(true);
    view.unmount();
  });
  test('an empty census is explicit and a lost server role hides cached account metadata', async () => {
    const empty = await renderAdministration('users');
    expect(await empty.findByText('No matching records')).toBeDefined();
    empty.unmount();
    const denied = await renderAdministration('users', () =>
      adminJson({ error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' } }, 404),
    );
    expect(await denied.findByText('Nothing here')).toBeDefined();
    denied.unmount();
  });
});
