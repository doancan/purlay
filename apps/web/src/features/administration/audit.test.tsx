import { describe, expect, test } from 'bun:test';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { ServerAuditAction } from '@purlay/types';
import { en } from '../../i18n/catalogue/en';
import { tr } from '../../i18n/catalogue/tr';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import {
  ADMIN_STAMP,
  ADMIN_USER,
  adminJson,
  adminError,
  renderAdministration,
} from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
describe('server audit browsing', () => {
  test('a newer action remains readable and a former actor can still be chosen from the entry', async () => {
    const view = await renderAdministration('audit', (call) =>
      call.path.startsWith('/api/server/audit')
        ? adminJson({
            data: [
              {
                id: ADMIN_USER.id,
                action: 'future.server_action',
                actorUserId: ADMIN_USER.id,
                actorName: null,
                targetUserId: null,
                targetWorkspaceId: null,
                targetModule: null,
                note: null,
                createdAt: ADMIN_STAMP,
              },
            ],
            nextCursor: null,
          })
        : undefined,
    );
    expect(await view.findByText('future.server_action')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'System / erased account' }));
    await person().click(view.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(view.calls.at(-1)?.path).toContain(`actorUserId=${ADMIN_USER.id}`);
    });
    view.unmount();
  });
  test('each server action has English and Turkish wording', () => {
    for (const item of ServerAuditAction.anyOf) {
      expect(en[`admin.audit.action.${item.const}`]).toBeDefined();
      expect(tr[`admin.audit.action.${item.const}`]).toBeDefined();
    }
  });
  test('readable actions, a searchable person choice and both downloads use the applied filter', async () => {
    const entry = {
      id: ADMIN_USER.id,
      action: 'server.smtp_tested',
      actorUserId: ADMIN_USER.id,
      actorName: ADMIN_USER.displayName,
      targetUserId: null,
      targetWorkspaceId: null,
      targetModule: null,
      note: null,
      createdAt: ADMIN_STAMP,
    };
    const view = await renderAdministration('audit', (call) =>
      call.path.startsWith('/api/server/audit')
        ? adminJson({ data: [entry], nextCursor: null })
        : call.path.startsWith('/api/server/users?')
          ? adminJson({ data: [ADMIN_USER], nextCursor: null })
          : undefined,
    );
    expect(await view.findByText('Email connection tested')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Person: Anyone' }));
    const dialog = within(await view.findByRole('dialog', { name: 'Choose a person' }));
    await person().type(dialog.getByLabelText('Search by name, username or email'), 'ada');
    await person().click(dialog.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(view.calls.some((call) => call.path.includes('/api/server/users?q=ada'))).toBe(true);
    });
    await person().click(
      await dialog.findByRole('button', { name: 'Select Ada Lovelace · ada@example.test' }),
    );
    await person().selectOptions(view.getByLabelText('Action'), 'server.smtp_tested');
    await person().click(view.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(view.calls.at(-1)?.path).toContain(`actorUserId=${ADMIN_USER.id}`);
    });
    for (const [name, format] of [
      ['Download CSV', 'csv'],
      ['Download NDJSON', 'ndjson'],
    ] as const) {
      const link = view.getByRole('link', { name });
      const url = new URL(link.getAttribute('href') ?? '', 'https://purlay.test');
      expect(url.pathname).toBe('/api/server/audit/export');
      expect(url.searchParams.get('action')).toBe('server.smtp_tested');
      expect(url.searchParams.get('actorUserId')).toBe(ADMIN_USER.id);
      expect(url.searchParams.get('format')).toBe(format);
      expect(url.searchParams.has('after')).toBe(false);
    }
    await person().click(view.getByRole('button', { name: 'Person: Ada Lovelace' }));
    const clearing = within(await view.findByRole('dialog', { name: 'Choose a person' }));
    await person().click(clearing.getByRole('button', { name: 'Anyone' }));
    await person().click(view.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(view.calls.at(-1)?.path).not.toContain('actorUserId=');
    });
    view.unmount();
  });
  test('the person directory retries, pages and cancels without applying the surrounding filter form', async () => {
    let fail = true;
    const older = {
      ...ADMIN_USER,
      id: '019a0000-0000-7000-8000-000000000001',
      displayName: 'Older person',
    };
    const view = await renderAdministration('audit', (call) => {
      if (!call.path.startsWith('/api/server/users?')) return undefined;
      if (fail) return adminError();
      const params = new URL(call.path, 'https://purlay.test').searchParams;
      return adminJson({
        data: params.get('q') === 'missing' ? [] : [params.has('after') ? older : ADMIN_USER],
        nextCursor: params.has('after') || params.get('q') === 'missing' ? null : ADMIN_USER.id,
      });
    });
    await person().selectOptions(await view.findByLabelText('Action'), 'server.account_suspended');
    await person().click(view.getByRole('button', { name: 'Person: Anyone' }));
    const dialog = within(await view.findByRole('dialog', { name: 'Choose a person' }));
    await dialog.findByRole('button', { name: 'Retry' });
    fail = false;
    await person().click(dialog.getByRole('button', { name: 'Retry' }));
    await dialog.findByRole('button', { name: 'Select Ada Lovelace · ada@example.test' });
    await person().click(dialog.getByRole('button', { name: 'Next page' }));
    expect(
      await dialog.findByRole('button', { name: 'Select Older person · ada@example.test' }),
    ).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Previous page' }));
    await person().type(dialog.getByLabelText('Search by name, username or email'), 'missing');
    await person().click(dialog.getByRole('button', { name: 'Search' }));
    expect(await dialog.findByText('No matching records')).toBeDefined();
    expect(
      view.calls.some(
        (call) =>
          call.path.startsWith('/api/server/audit?') &&
          call.path.includes('action=server.account_suspended'),
      ),
    ).toBe(false);
    await person().click(dialog.getByRole('button', { name: 'Close' }));
    expect(view.getByRole('button', { name: 'Person: Anyone' })).toBeDefined();
    view.unmount();
  });
  test('filters are validated, converted to instants and reset keyset history; pages remain metadata only', async () => {
    const entry = {
      id: ADMIN_USER.id,
      action: 'server.smtp_tested',
      actorUserId: ADMIN_USER.id,
      actorName: 'Ada Lovelace',
      targetUserId: ADMIN_USER.id,
      targetWorkspaceId: null,
      targetModule: null,
      note: null,
      createdAt: ADMIN_STAMP,
    };
    const view = await renderAdministration('audit', (call) =>
      call.path.startsWith('/api/server/audit')
        ? adminJson({ data: [entry], nextCursor: call.path.includes('after=') ? null : entry.id })
        : undefined,
    );
    expect(await view.findByText('Ada Lovelace')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Next page' }));
    await settle();
    expect(view.calls.at(-1)?.path).toContain('after=');
    await person().click(view.getByRole('button', { name: 'Previous page' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Ada Lovelace' }));
    await person().click(view.getByLabelText('From (local time)'));
    fireEvent.change(view.getByLabelText('From (local time)'), {
      target: { value: '2026-11-07T10:00' },
    });
    await person().keyboard('{ArrowRight}');
    await person().click(view.getByLabelText('To (local time)'));
    fireEvent.change(view.getByLabelText('To (local time)'), {
      target: { value: '2026-11-06T10:00' },
    });
    await person().keyboard('{ArrowRight}');
    await person().click(view.getByRole('button', { name: 'Search' }));
    expect(await view.findByRole('alert')).toBeDefined();
    await person().click(view.getByLabelText('From (local time)'));
    fireEvent.change(view.getByLabelText('From (local time)'), {
      target: { value: '2026-11-01T10:00' },
    });
    await person().keyboard('{ArrowRight}');
    await person().selectOptions(view.getByLabelText('Action'), 'server.smtp_tested');
    await person().click(view.getByRole('button', { name: 'Search' }));
    await settle();
    const request = view.calls.at(-1)?.path ?? '';
    expect(request).toContain('action=server.smtp_tested');
    expect(request).toContain('from=');
    expect(request).toContain('to=');
    expect(request).not.toContain('after=');
    view.unmount();
  });
  test('an erased actor and a workspace target remain readable; an empty search is explicit', async () => {
    let empty = false;
    const view = await renderAdministration('audit', (call) =>
      call.path.startsWith('/api/server/audit')
        ? adminJson({
            data: empty
              ? []
              : [
                  {
                    id: ADMIN_USER.id,
                    action: 'server.workspace_purged',
                    actorUserId: null,
                    actorName: null,
                    targetUserId: null,
                    targetWorkspaceId: ADMIN_USER.id,
                    targetModule: null,
                    note: null,
                    createdAt: ADMIN_STAMP,
                  },
                ],
            nextCursor: null,
          })
        : undefined,
    );
    expect(await view.findByText('System / erased account')).toBeDefined();
    empty = true;
    await person().click(view.getByRole('button', { name: 'Search' }));
    // Change a filter so the real query key changes.
    await person().selectOptions(view.getByLabelText('Action'), 'server.smtp_tested');
    await person().click(view.getByRole('button', { name: 'Search' }));
    expect(await view.findByText('No matching records')).toBeDefined();
    view.unmount();
  });
});
