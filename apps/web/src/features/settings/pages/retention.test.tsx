/**
 * How long the workspace keeps its history (D-139 §4), on the Data & retention page (D-146), against
 * the fake API: an owner's alone; read
 * first, with its loading and its failure; a shorter window said in full before it is saved, in red;
 * a longer one plainly; a window set some other way shown as itself; a refusal said, in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { WORKSPACE, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const render = async (
  path: string,
  api: Partial<Api>,
  role: UserRole,
  locale: 'en' | 'tr',
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path,
      locale,
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            memberships: session.memberships.map((m) => ({ ...m, role })),
          }),
        // The page's other card: the exports.
        exports: () => Promise.resolve([]),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

/** The Data & retention page, loaded: its chunk is lazy, so the heading is waited for. */
const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
  locale: 'en' | 'tr' = 'en',
): Promise<View> => {
  const view = await render('/w/acme/settings/data', api, role, locale);
  await view.findByRole('heading', {
    level: 1,
    name: locale === 'en' ? 'Data & retention' : 'Veri ve saklama',
  });
  await settle();
  return view;
};

/** The card that holds the setting. */
const cardOf = (view: View, name = 'History'): HTMLElement => view.getByRole('region', { name });

describe('how long the workspace keeps its history', () => {
  test('is an owner’s alone: an admin and a member are not offered it, and its address is not found', async () => {
    for (const role of ['admin', 'member'] as const) {
      const view = await render('/w/acme/settings/data', {}, role, 'en');
      expect(await view.findByText('Nothing here')).toBeDefined();
      expect(view.queryByRole('link', { name: 'Data & retention' })).toBeNull();
      view.unmount();
    }
  });

  test('a shorter window is said in full, in red, before it is saved; then saved and said', async () => {
    const asked: [string, number | null][] = [];
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
      setRetention: (workspaceId, retentionDays) => {
        asked.push([workspaceId, retentionDays]);
        return Promise.resolve({ retentionDays, channelsKeptLonger: 0 });
      },
    });
    const dialog = cardOf(view);
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
    await expectNoAxeViolations(view.getByRole('main'));
    await person().click(destroy);
    await settle();
    expect(asked).toEqual([[WORKSPACE.id, 90]]);
    expect(view.getByText('Saved.')).toBeDefined();
    // What is held now is what was chosen: nothing more to save, nothing more to warn of.
    expect(within(dialog).queryByRole('note')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  test('left without saving, nothing is saved, and coming back starts from what is held', async () => {
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
      setRetention: () => {
        throw new Error('nothing should be saved');
      },
    });
    await person().selectOptions(within(cardOf(view)).getByLabelText('Keep history'), '30 days');
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    await person().click(view.getByRole('link', { name: 'Data & retention' }));
    await view.findByRole('heading', { level: 1, name: 'Data & retention' });
    await settle();
    expect(within(cardOf(view)).getByLabelText<HTMLSelectElement>('Keep history').value).toBe(
      'forever',
    );
  });

  test('a longer window, or forever, deletes nothing and is said plainly', async () => {
    const asked: (number | null)[] = [];
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: 90, channelsKeptLonger: 0 }),
      setRetention: (_workspaceId, retentionDays) => {
        asked.push(retentionDays);
        return Promise.resolve({ retentionDays, channelsKeptLonger: 0 });
      },
    });
    const dialog = cardOf(view);
    await person().selectOptions(within(dialog).getByLabelText('Keep history'), 'Forever');
    expect(within(dialog).queryByRole('note')).toBeNull();
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(asked).toEqual([null]);
  });

  test('a window set some other way is shown as itself, not as a neighbour', async () => {
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: 45, channelsKeptLonger: 0 }),
    });
    const dialog = cardOf(view);
    const select = within(dialog).getByLabelText<HTMLSelectElement>('Keep history');
    expect(select.value).toBe('45');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Forever',
      '30 days',
      '45 days',
      '90 days',
      '1 year',
      '2 years',
      '5 years',
    ]);
  });

  test('channels that keep longer are counted beside the window, in either language; none, nothing said', async () => {
    const counted = await open({
      retention: () => Promise.resolve({ retentionDays: 30, channelsKeptLonger: 2 }),
    });
    expect(cardOf(counted).textContent).toContain(
      '2 channels keep their history longer than this. Each one’s details say how long.',
    );
    counted.unmount();

    const one = await open(
      { retention: () => Promise.resolve({ retentionDays: 30, channelsKeptLonger: 1 }) },
      'owner',
      'tr',
    );
    expect(cardOf(one, 'Geçmiş').textContent).toContain(
      '1 kanal geçmişini bundan daha uzun saklıyor.',
    );
    one.unmount();

    const none = await open({
      retention: () => Promise.resolve({ retentionDays: 30, channelsKeptLonger: 0 }),
    });
    expect(cardOf(none).textContent).not.toContain('longer than this');
  });

  test('the windows offered are named as a person says them: forever, days, years', async () => {
    const view = await open({
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
    });
    const select = within(cardOf(view)).getByLabelText<HTMLSelectElement>('Keep history');
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['forever', 'Forever'],
      ['30', '30 days'],
      ['90', '90 days'],
      ['365', '1 year'],
      ['730', '2 years'],
      ['1825', '5 years'],
    ]);
  });

  test('while it is read, says so; a failure to read offers Retry, which reads again', async () => {
    let calls = 0;
    const view = await open({
      retention: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
        return await Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 });
      },
    });
    const dialog = cardOf(view);
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(dialog).getByLabelText('Keep history')).toBeDefined();
    view.unmount();

    const pending = await open({ retention: () => new Promise(() => undefined) });
    expect(within(cardOf(pending)).getByRole('status')).toBeDefined();
  });

  test('a refusal is said, and the choice stays for another try — in Turkish too', async () => {
    const view = await open(
      {
        retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
        setRetention: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
      },
      'owner',
      'tr',
    );
    const dialog = cardOf(view, 'Geçmiş');
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
