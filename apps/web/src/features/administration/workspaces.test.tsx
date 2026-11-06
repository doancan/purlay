import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import {
  ADMIN_STAMP,
  ADMIN_WORKSPACE,
  adminError,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
describe('global workspace inventory', () => {
  test('search and status filters reset pages; data view exposes retention without changing owner policy', async () => {
    for (const section of ['workspaces', 'data']) {
      const view = await renderAdministration(section, (call) =>
        call.path.startsWith('/api/server/workspaces')
          ? adminJson({
              data: [
                {
                  ...ADMIN_WORKSPACE,
                  deletedAt: ADMIN_STAMP,
                  purgedAt: ADMIN_STAMP,
                  owners: [],
                  ownerCount: 0,
                  retentionDays: null,
                },
              ],
              nextCursor: call.path.includes('after=') ? null : ADMIN_WORKSPACE.id,
            })
          : undefined,
      );
      expect(await view.findByText('Forever')).toBeDefined();
      expect(view.queryByRole('button', { name: 'Change quota' })).toBeNull();
      await person().click(view.getByRole('button', { name: 'Next page' }));
      await settle();
      await person().click(view.getByRole('button', { name: 'Previous page' }));
      await settle();
      await person().type(view.getByLabelText('Search by name or slug'), 'Research');
      for (const status of ['active', 'deleted', 'full', '']) {
        await person().selectOptions(view.getByLabelText('Status'), status);
        await person().click(view.getByRole('button', { name: 'Search' }));
        await settle();
      }
      expect(view.calls.some((call) => call.path.includes('status=full'))).toBe(true);
      view.unmount();
    }
  });
  test('empty results, quota failure, dismissal and retry are explicit', async () => {
    const empty = await renderAdministration('workspaces');
    expect(await empty.findByText('No matching records')).toBeDefined();
    empty.unmount();
    let fail = true;
    const view = await renderAdministration('workspaces', (call) =>
      call.method === 'GET' && call.path.startsWith('/api/server/workspaces')
        ? adminJson({ data: [ADMIN_WORKSPACE], nextCursor: null })
        : call.path.endsWith('/quota') && fail
          ? adminError()
          : undefined,
    );
    await person().click(await view.findByRole('button', { name: 'Change quota' }));
    let dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Change quota' }));
    dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Save quota' }));
    expect(await dialog.findByRole('alert')).toBeDefined();
    await person().keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    fail = false;
    await person().click(view.getByRole('button', { name: 'Change quota' }));
    dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByLabelText('Quota in bytes'));
    await person().keyboard('{Enter}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });
});
