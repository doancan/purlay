/**
 * How long the workspace keeps its history (D-139 §4), against the fake API: an owner's alone; read
 * first, with its loading and its failure; a shorter window said in full before it is saved, in red;
 * a longer one plainly; a window set some other way shown as itself; a refusal said, in both languages.
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
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    locale,
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
  const switcher = locale === 'en' ? 'Switch workspace' : 'Çalışma alanını değiştir';
  await person().click(view.getByRole('button', { name: switcher }));
  return view;
};

const dialogOf = async (view: Awaited<ReturnType<typeof renderApp>>): Promise<HTMLElement> => {
  await person().click(view.getByRole('menuitem', { name: 'Keep history…' }));
  await settle();
  return view.getByRole('dialog');
};

describe('how long the workspace keeps its history', () => {
  test('is an owner’s alone: an admin and a member are not offered it', async () => {
    for (const role of ['admin', 'member'] as const) {
      const view = await open({}, role);
      expect(view.queryByRole('menuitem', { name: 'Keep history…' })).toBeNull();
      view.unmount();
    }
  });

  test('a shorter window is said in full, in red, before it is saved; then saved and closed', async () => {
    const asked: [string, number | null][] = [];
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: null }),
      setRetention: (workspaceId, retentionDays) => {
        asked.push([workspaceId, retentionDays]);
        return Promise.resolve({ retentionDays });
      },
    });
    const dialog = await dialogOf(view);
    const select = within(dialog).getByLabelText('Keep history');
    expect((select as HTMLSelectElement).value).toBe('forever');
    // The same window as now: nothing to save.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await person().selectOptions(select, '90 days');
    expect(within(dialog).getByRole('note').textContent).toContain(
      'messages and files older than 90 days will be deleted for good',
    );
    const destroy = within(dialog).getByRole('button', {
      name: 'Delete history older than 90 days',
    });
    expect(destroy.className).toContain('bg-danger');
    await expectNoAxeViolations(dialog);
    await person().click(destroy);
    await settle();
    expect(asked).toEqual([[WORKSPACE.id, 90]]);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('Cancel closes it and saves nothing, and the next opening starts from what is held', async () => {
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: null }),
      setRetention: () => {
        throw new Error('nothing should be saved');
      },
    });
    let dialog = await dialogOf(view);
    await person().selectOptions(within(dialog).getByLabelText('Keep history'), '30 days');
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    dialog = await dialogOf(view);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Keep history').value).toBe('forever');
  });

  test('a longer window, or forever, deletes nothing and is said plainly', async () => {
    const asked: (number | null)[] = [];
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: 90 }),
      setRetention: (_workspaceId, retentionDays) => {
        asked.push(retentionDays);
        return Promise.resolve({ retentionDays });
      },
    });
    const dialog = await dialogOf(view);
    await person().selectOptions(within(dialog).getByLabelText('Keep history'), 'forever');
    expect(within(dialog).queryByRole('note')).toBeNull();
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(asked).toEqual([null]);
  });

  test('a window set some other way is shown as itself, not as a neighbour', async () => {
    const view = await open({ retention: () => Promise.resolve({ retentionDays: 45 }) });
    const dialog = await dialogOf(view);
    const select = within(dialog).getByLabelText<HTMLSelectElement>('Keep history');
    expect(select.value).toBe('45');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'forever',
      '30 days',
      '45 days',
      '90 days',
      '365 days',
      '730 days',
      '1825 days',
    ]);
  });

  test('while it is read, says so; a failure to read offers Retry, which reads again', async () => {
    let calls = 0;
    const view = await open({
      retention: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
        return await Promise.resolve({ retentionDays: null });
      },
    });
    const dialog = await dialogOf(view);
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(dialog).getByLabelText('Keep history')).toBeDefined();
    view.unmount();

    const pending = await open({ retention: () => new Promise(() => undefined) });
    const waiting = await dialogOf(pending);
    expect(within(waiting).getByRole('status')).toBeDefined();
  });

  test('a refusal is said, and the choice stays for another try — in Turkish too', async () => {
    const view = await open(
      {
        retention: () => Promise.resolve({ retentionDays: null }),
        setRetention: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
      },
      'owner',
      'tr',
    );
    await person().click(view.getByRole('menuitem', { name: 'Geçmişi sakla…' }));
    await settle();
    const dialog = view.getByRole('dialog');
    const select = within(dialog).getByLabelText<HTMLSelectElement>('Geçmişi sakla');
    await person().selectOptions(select, '30 gün');
    await person().click(
      within(dialog).getByRole('button', { name: '30 günden eski geçmişi sil' }),
    );
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('Ayar kaydedilmedi.');
    expect(select.value).toBe('30');
  });
});
