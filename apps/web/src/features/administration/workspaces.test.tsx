import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
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
  test('the modules of a workspace are said one by one, only what changed is sent, and a refusal is shown', async () => {
    const withModules = {
      ...ADMIN_WORKSPACE,
      modules: [
        {
          module: 'issues',
          state: 'inherit',
          effective: true,
          validUntil: null,
          source: null,
          running: true,
        },
        {
          module: 'tasks',
          state: 'on',
          effective: true,
          validUntil: null,
          source: 'operator',
          running: true,
        },
      ],
    };
    let refuse = true;
    const view = await renderAdministration('workspaces', (call) => {
      if (call.method === 'GET' && call.path.startsWith('/api/server/workspaces'))
        return adminJson({ data: [withModules], nextCursor: null });
      if (call.path.endsWith('/modules') && refuse)
        return adminJson(
          { error: { code: 'MODULE_REQUIRES', message: 'The module requires issues.' } },
          409,
        );
      return undefined;
    });
    await person().click(await view.findByRole('button', { name: 'Modules' }));
    let dialog = within(view.getByRole('dialog'));
    // Nothing changed: saving sends nothing and closes.
    await person().click(dialog.getByRole('button', { name: 'Save modules' }));
    await settle();
    expect(view.calls.filter((call) => call.path.endsWith('/modules'))).toEqual([]);
    expect(view.queryByRole('dialog')).toBeNull();

    await person().click(view.getByRole('button', { name: 'Modules' }));
    dialog = within(view.getByRole('dialog'));
    await person().selectOptions(dialog.getByLabelText('issues'), 'off');
    await person().click(dialog.getByRole('button', { name: 'Save modules' }));
    expect(await dialog.findByRole('alert')).toBeDefined();
    const sent = view.calls.filter((call) => call.path.endsWith('/modules'));
    expect(sent.map((call) => call.path)).toEqual([
      `/api/server/workspaces/${ADMIN_WORKSPACE.id}/modules`,
    ]);
    expect(sent[0]?.body).toEqual({ module: 'issues', state: 'off' });

    // Escape leaves it as Cancel does; the form submitted by its own means says what the button says.
    await person().keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    refuse = false;
    await person().click(view.getByRole('button', { name: 'Modules' }));
    dialog = within(view.getByRole('dialog'));
    await person().selectOptions(dialog.getByLabelText('tasks'), 'inherit');
    const form = view.getByRole('dialog').querySelector('form');
    if (form === null) throw new Error('the dialog has no form');
    fireEvent.submit(form);
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(
      view.calls.filter((call) => call.path.endsWith('/modules')).map((call) => call.body),
    ).toEqual([
      { module: 'issues', state: 'off' },
      { module: 'tasks', state: 'inherit' },
    ]);
    view.unmount();
  });
});
