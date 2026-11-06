import { describe, expect, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
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
  test('the selection bound holds across pages and Escape cancels an idle confirmation', async () => {
    const users = Array.from({ length: 50 }, (_, index) => ({
      ...account,
      id: crypto.randomUUID(),
      displayName: `Pending ${String(index)}`,
      admissionState: 'pending',
    }));
    const last = {
      ...account,
      id: crypto.randomUUID(),
      displayName: 'Beyond limit',
      admissionState: 'pending',
    };
    const view = await renderAdministration('users', (call) =>
      call.path.startsWith('/api/server/users?')
        ? adminJson({
            data: call.path.includes('after=') ? [last] : users,
            nextCursor: call.path.includes('after=') ? null : users.at(-1)?.id,
          })
        : undefined,
    );
    await person().click(
      await view.findByRole('button', { name: 'Select pending accounts on this page' }),
    );
    expect(view.getByText('50 selected')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Next page' }));
    expect(await view.findByRole('checkbox', { name: 'Select Beyond limit' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      view.getByRole('button', { name: 'Select pending accounts on this page' }),
    ).toHaveProperty('disabled', true);
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    expect(within(view.getByRole('dialog')).getAllByRole('listitem')).toHaveLength(50);
    await person().keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.calls.some((call) => call.path === '/api/server/users/approve')).toBe(false);
    view.unmount();
  });
  test.each([true, false])(
    'a pending batch disables overlapping actions and navigation cancels unstarted work (valid reply: %s)',
    async (valid) => {
      let finish: (value: unknown) => void = () => undefined;
      const view = await renderAdministration('users', (call) => {
        if (call.path.startsWith('/api/server/users?'))
          return adminJson({ data: [{ ...account, admissionState: 'pending' }], nextCursor: null });
        if (call.path === '/api/server/users/approve')
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                finish = (value): void => {
                  controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                  controller.close();
                };
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return undefined;
      });
      await person().click(
        await view.findByRole('button', { name: 'Select pending accounts on this page' }),
      );
      await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
      const dialog = within(view.getByRole('dialog'));
      await person().click(dialog.getByRole('button', { name: 'Confirm approvals' }));
      await person().click(dialog.getByRole('button', { name: 'Confirm approvals' }));
      expect(view.calls.filter((call) => call.path === '/api/server/users/approve')).toHaveLength(
        1,
      );
      expect(view.getByLabelText('Status')).toHaveProperty('disabled', true);
      expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
      await person().keyboard('{Escape}');
      expect(view.getByRole('dialog')).toBeDefined();
      const signal = view.calls.find((call) => call.path === '/api/server/users/approve')?.signal;
      expect(signal?.aborted).toBe(false);
      const count = view.calls.length;
      view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        finish(
          valid ? { results: [{ userId: account.id, outcome: 'approved' }] } : { wrong: true },
        );
        await Promise.resolve();
      });
      await settle();
      expect(view.calls).toHaveLength(count);
    },
  );
  test('selection survives pages, cancellation sends nothing and changing the filter clears selection', async () => {
    const second = {
      ...account,
      id: '00000000-0000-4000-8000-0000000000a3',
      displayName: 'Grace Hopper',
    };
    const view = await renderAdministration('users', (call) =>
      call.path.startsWith('/api/server/users?')
        ? adminJson({
            data: [
              { ...(call.path.includes('after=') ? second : account), admissionState: 'pending' },
            ],
            nextCursor: call.path.includes('after=') ? null : account.id,
          })
        : undefined,
    );
    await person().click(await view.findByRole('checkbox', { name: 'Select Ada Lovelace' }));
    await person().click(view.getByRole('button', { name: 'Next page' }));
    await person().click(await view.findByRole('checkbox', { name: 'Select Grace Hopper' }));
    expect(view.getByText('2 selected')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText('Ada Lovelace')).toBeDefined();
    expect(dialog.getByText('Grace Hopper')).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(view.calls.some((call) => call.path === '/api/server/users/approve')).toBe(false);
    await person().click(view.getByRole('button', { name: 'Clear selection' }));
    expect(view.getByText('0 selected')).toBeDefined();
    await person().click(view.getByRole('checkbox', { name: 'Select Grace Hopper' }));
    await person().selectOptions(view.getByLabelText('Status'), 'pending');
    await person().click(view.getByRole('button', { name: 'Search' }));
    expect(await view.findByText('0 selected')).toBeDefined();
    expect(view.getByRole('button', { name: 'Approve selected accounts' })).toHaveProperty(
      'disabled',
      true,
    );
    view.unmount();
  });

  test('an unconfirmed batch keeps selection and offers an explicit refresh and retry', async () => {
    let fail = true;
    const view = await renderAdministration('users', (call) => {
      if (call.path.startsWith('/api/server/users?'))
        return adminJson({ data: [{ ...account, admissionState: 'pending' }], nextCursor: null });
      if (call.path === '/api/server/users/approve')
        return fail
          ? adminError()
          : adminJson({ results: [{ userId: account.id, outcome: 'approved' }] });
      return undefined;
    });
    await person().click(
      await view.findByRole('button', { name: 'Select pending accounts on this page' }),
    );
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Confirm approvals' }),
    );
    expect(
      await view.findByText(
        'Could not confirm the approval results. Refresh accounts before retrying.',
      ),
    ).toBeDefined();
    expect(view.queryByRole('region', { name: 'Approval results' })).toBeNull();
    const reads = view.calls.filter((call) => call.path.startsWith('/api/server/users?')).length;
    await person().click(view.getByRole('button', { name: 'Refresh accounts' }));
    await waitFor(() => {
      expect(
        view.calls.filter((call) => call.path.startsWith('/api/server/users?')).length,
      ).toBeGreaterThan(reads);
    });
    fail = false;
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Confirm approvals' }),
    );
    expect(await view.findByRole('region', { name: 'Approval results' })).toBeDefined();
    view.unmount();
  });
  test('a named batch keeps per-account outcomes and retains only unsuccessful selections for explicit retry', async () => {
    const second = {
      ...account,
      id: '00000000-0000-4000-8000-0000000000a3',
      displayName: 'Grace Hopper',
    };
    let attempts = 0;
    const view = await renderAdministration('users', (call) => {
      if (call.method === 'GET' && call.path.startsWith('/api/server/users?'))
        return adminJson({
          data: [account, second].map((u) => ({ ...u, admissionState: 'pending' })),
          nextCursor: null,
        });
      if (call.path === '/api/server/users/approve') {
        attempts++;
        return adminJson({
          results:
            attempts === 1
              ? [
                  { userId: account.id, outcome: 'approved' },
                  { userId: second.id, outcome: 'refused' },
                ]
              : [{ userId: second.id, outcome: 'approved' }],
        });
      }
      return undefined;
    });
    await person().click(
      await view.findByRole('button', { name: 'Select pending accounts on this page' }),
    );
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    const dialog = within(view.getByRole('dialog', { name: 'Approve selected accounts' }));
    expect(dialog.getByText('Grace Hopper')).toBeDefined();
    expect(dialog.getByText('Ada Lovelace')).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Confirm approvals' }));
    const results = within(await view.findByRole('region', { name: 'Approval results' }));
    expect(await results.findByText('Not approved; status or permissions changed.')).toBeDefined();
    expect(results.getByText('Approved')).toBeDefined();
    expect(view.calls.find((call) => call.path === '/api/server/users/approve')?.body).toEqual({
      userIds: [account.id, second.id],
    });
    expect(view.getByRole('checkbox', { name: 'Select Grace Hopper' })).toHaveProperty(
      'checked',
      true,
    );
    await person().click(view.getByRole('button', { name: 'Approve selected accounts' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Confirm approvals' }),
    );
    await waitFor(() => {
      expect(attempts).toBe(2);
    });
    expect(
      view.calls.filter((call) => call.path === '/api/server/users/approve').at(-1)?.body,
    ).toEqual({ userIds: [second.id] });
    view.unmount();
  });
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
