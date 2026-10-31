/**
 * How much room the workspace's files take (D-173), on the Data & retention page, against the fake
 * API: loading, a failure with Retry, a meter with its numbers in words in both languages, the warning
 * and the full states, and nothing that changes the quota — the operator sets it.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { StorageUsage } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();

const GB = 1024 ** 3;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Partial<Api>, locale: 'en' | 'tr' = 'en'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/data',
    locale,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role: 'owner' as const })),
        }),
      exports: () => Promise.resolve([]),
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
      ...api,
    }),
  });
  await view.findByRole('heading', {
    level: 1,
    name: locale === 'en' ? 'Data & retention' : 'Veri ve saklama',
  });
  await settle();
  return view;
};

const using = (usage: StorageUsage): Partial<Api> => ({ storage: () => Promise.resolve(usage) });

describe('the storage card', () => {
  test('a meter with what is used and the quota, in words, and what is left — nothing to change it with', async () => {
    const view = await open(using({ usedBytes: 1.2 * GB, quotaBytes: 5 * GB }));
    const card = view.getByRole('region', { name: 'Storage' });
    const meter = within(card).getByRole('meter', { name: 'Storage used' });
    expect(meter.getAttribute('aria-valuetext')).toBe('1.2 GB of 5 GB');
    expect(meter.getAttribute('aria-valuenow')).toBe(String(1.2 * GB));
    expect(meter.getAttribute('aria-valuemax')).toBe(String(5 * GB));
    expect(within(card).getByText('1.2 GB of 5 GB')).toBeDefined();
    expect(within(card).getByText('3.8 GB left')).toBeDefined();
    expect(within(card).getByText(/The server’s operator sets the quota/)).toBeDefined();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByRole('textbox')).toBeNull();
    const bar = meter.firstElementChild;
    expect(bar?.className).toContain('bg-accent');
    expect((bar as HTMLElement | null)?.style.width).toBe('24%');
    await expectNoAxeViolations(card);
    view.unmount();
  });

  test('nearly full is drawn in the warning tone; full, or past it, says files are refused', async () => {
    const nearly = await open(using({ usedBytes: 4.6 * GB, quotaBytes: 5 * GB }));
    const nearlyMeter = within(nearly.getByRole('region', { name: 'Storage' })).getByRole('meter');
    expect(nearlyMeter.firstElementChild?.className).toContain('bg-warning');
    nearly.unmount();

    const past = await open(using({ usedBytes: 6 * GB, quotaBytes: 5 * GB }));
    const card = past.getByRole('region', { name: 'Storage' });
    const meter = within(card).getByRole('meter');
    expect(meter.firstElementChild?.className).toContain('bg-danger');
    expect((meter.firstElementChild as HTMLElement | null)?.style.width).toBe('100%');
    expect(meter.getAttribute('aria-valuenow')).toBe(String(5 * GB));
    expect(within(card).getByText(/No room is left/)).toBeDefined();
    past.unmount();

    const none = await open(using({ usedBytes: 0, quotaBytes: 0 }));
    expect(
      within(none.getByRole('region', { name: 'Storage' })).getByText(/No room is left/),
    ).toBeDefined();
    none.unmount();
  });

  test('says it is loading, and a failure with Retry that asks again', async () => {
    let answer: () => Promise<StorageUsage> = () =>
      Promise.reject(new ApiError(500, 'INTERNAL', 'no'));
    const view = await open({ storage: () => answer() });
    const card = view.getByRole('region', { name: 'Storage' });
    expect(within(card).queryByRole('meter')).toBeNull();
    answer = (): Promise<StorageUsage> => Promise.resolve({ usedBytes: 512, quotaBytes: GB });
    await person().click(within(card).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(card).getByRole('meter').getAttribute('aria-valuetext')).toBe(
      '512 bytes of 1 GB',
    );
    view.unmount();

    const slow = await open({ storage: () => new Promise<StorageUsage>(() => undefined) });
    expect(
      within(slow.getByRole('region', { name: 'Storage' })).getByText('Loading'),
    ).toBeDefined();
    slow.unmount();
  });

  test('in Turkish', async () => {
    const view = await open(using({ usedBytes: 1.2 * GB, quotaBytes: 5 * GB }), 'tr');
    const card = view.getByRole('region', { name: 'Depolama' });
    expect(within(card).getByRole('meter', { name: 'Kullanılan depolama' })).toBeDefined();
    expect(within(card).getByText('1,2 GB / 5 GB')).toBeDefined();
    expect(within(card).getByText('Kalan: 3,8 GB')).toBeDefined();
    await expectNoAxeViolations(card);
    view.unmount();
  });
});
