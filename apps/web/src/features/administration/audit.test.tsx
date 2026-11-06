import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import {
  ADMIN_STAMP,
  ADMIN_USER,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
describe('server audit browsing', () => {
  test('filters are validated, converted to instants and reset keyset history; pages remain metadata only', async () => {
    const entry = {
      id: ADMIN_USER.id,
      action: 'server.smtp_tested',
      actorUserId: ADMIN_USER.id,
      actorName: 'Ada Lovelace',
      targetUserId: ADMIN_USER.id,
      targetWorkspaceId: null,
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
    await person().type(view.getByLabelText('Actor ID'), 'invalid');
    await person().click(view.getByRole('button', { name: 'Search' }));
    expect(await view.findByRole('alert')).toBeDefined();
    await person().clear(view.getByLabelText('Actor ID'));
    await person().type(view.getByLabelText('Actor ID'), ADMIN_USER.id);
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
