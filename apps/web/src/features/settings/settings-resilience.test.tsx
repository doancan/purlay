/** Regression checks for delayed and failed writes across Settings. */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { QuietHoursSetting } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { keys } from '../../data/keys';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi, IDS, someMembers, WHEN } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';

installDom();

const pending = <T,>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} => {
  let resolve: (value: T) => void = (): void => {
    throw new Error('promise not initialized');
  };
  let reject: (reason: unknown) => void = (): void => {
    throw new Error('promise not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (
  section: string,
  api: Partial<Api> = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path: `/w/acme/settings/${section}`,
      api: aSignedInApi(api),
    },
  );
  await settle();
  await within(await view.findByRole('main')).findByRole('heading', { level: 1 });
  await settle();
  return view;
};
const quiet: QuietHoursSetting = {
  quietHours: { from: 19 * 60, to: 9 * 60, days: [1, 2, 3, 4, 5] },
  timeZone: 'Europe/Istanbul',
};
const connected = { configured: true, updatedAt: WHEN, invalidSince: null, broadScopes: false };

describe('settings request recovery', () => {
  test('quiet hours reports a failed read and Retry recovers', async () => {
    let failed = true;
    const view = await open('notifications', {
      quietHours: () =>
        failed
          ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
          : Promise.resolve(quiet),
    });
    const card = within(view.getByRole('region', { name: 'Quiet hours' }));
    expect(card.getByRole('alert').textContent).toContain('Quiet hours could not be loaded.');
    failed = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(card.getByLabelText<HTMLInputElement>('From').value).toBe('19:00');
  });

  test('an incomplete quiet-hours time cannot silently save the previous time', async () => {
    const view = await open('notifications', { quietHours: () => Promise.resolve(quiet) });
    const card = within(view.getByRole('region', { name: 'Quiet hours' }));
    await person().click(card.getByRole('checkbox', { name: 'Friday' }));
    await person().click(card.getByLabelText('From'));
    await person().clear(card.getByLabelText('From'));
    await person().keyboard('{Backspace}');
    await settle();
    expect(card.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(card.getByLabelText('From').getAttribute('aria-invalid')).toBe('true');
    expect(card.getByRole('alert').textContent).toContain('Enter a start and end time.');
  });

  test('quiet-hours controls are held until the save answers', async () => {
    const request = pending<QuietHoursSetting>();
    const view = await open('notifications', {
      quietHours: () => Promise.resolve(quiet),
      setQuietHours: () => request.promise,
    });
    const card = within(view.getByRole('region', { name: 'Quiet hours' }));
    await person().click(card.getByRole('checkbox', { name: 'Friday' }));
    await person().click(card.getByRole('button', { name: 'Save' }));
    expect(card.getByRole<HTMLInputElement>('checkbox', { name: 'Quiet hours' }).disabled).toBe(
      true,
    );
    expect(card.getByLabelText<HTMLInputElement>('From').disabled).toBe(true);
    expect(card.getByRole<HTMLInputElement>('checkbox', { name: 'Monday' }).disabled).toBe(true);
    request.resolve(quiet);
    await settle();
    expect(card.getByLabelText<HTMLInputElement>('From').disabled).toBe(false);
  });

  test('email-notification writes cannot overlap and failure restores the switch', async () => {
    const request = pending<Awaited<ReturnType<Api['setMissedMail']>>>();
    const view = await open('notifications', {
      missedMail: () => Promise.resolve({ on: false, available: true }),
      setMissedMail: () => request.promise,
    });
    const card = within(view.getByRole('region', { name: 'Email' }));
    const checkbox = card.getByRole<HTMLInputElement>('checkbox');
    await person().click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    request.reject(new ApiError(0, 'NETWORK', 'offline'));
    await settle();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
  });

  test('a channel notification change holds only that channel until its answer', async () => {
    const request = pending<Awaited<ReturnType<Api['setNotificationLevel']>>>();
    const view = await open('notifications', { setNotificationLevel: () => request.promise });
    const main = within(view.getByRole('main'));
    const select = main.getByRole<HTMLSelectElement>('combobox', {
      name: 'Notifications for #api',
    });
    await person().selectOptions(select, 'none');
    expect(select.disabled).toBe(true);
    expect(
      main.getByRole<HTMLSelectElement>('combobox', { name: 'Notifications for #deploys' })
        .disabled,
    ).toBe(false);
    request.reject(new ApiError(0, 'NETWORK', 'offline'));
    await settle();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('mentions');
  });

  test('a workspace rename cannot discard text typed while its request is pending', async () => {
    const request = pending<Awaited<ReturnType<Api['renameWorkspace']>>>();
    const view = await open('general', { renameWorkspace: () => request.promise });
    const main = within(view.getByRole('main'));
    const name = main.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    await person().clear(name);
    await person().type(name, 'New name');
    await person().click(main.getByRole('button', { name: 'Save' }));
    expect(name.readOnly).toBe(true);
    await person().type(name, ' lost edit');
    expect(name.value).toBe('New name');
    request.reject(new ApiError(0, 'NETWORK', 'offline'));
    await settle();
    expect(name.readOnly).toBe(false);
    expect(name.value).toBe('New name');
  });

  test('the profile device-timezone shortcut cannot unlock fields during a save', async () => {
    const request = pending<Awaited<ReturnType<Api['updateProfile']>>>();
    const session = aSession();
    const view = await open('profile', {
      me: () =>
        Promise.resolve({
          ...session,
          profile: { title: 'Engineer', timeZone: 'Europe/Istanbul', status: null },
        }),
      updateProfile: () => request.promise,
    });
    const main = within(view.getByRole('main'));
    await person().type(main.getByRole('textbox', { name: 'Title' }), ' II');
    await person().click(main.getByRole('button', { name: 'Save' }));
    const shortcut = main.getByRole<HTMLButtonElement>('button', {
      name: 'Use this device’s time zone',
    });
    expect(shortcut.disabled).toBe(true);
    request.resolve({ title: 'Engineer II', timeZone: 'Europe/Istanbul', status: null });
    await settle();
    expect(shortcut.disabled).toBe(false);
  });

  test('saving a GitHub token holds the token and disconnect controls', async () => {
    const request = pending<Awaited<ReturnType<Api['setGitHubToken']>>>();
    const view = await open('integrations', {
      githubIntegration: () => Promise.resolve(connected),
      setGitHubToken: () => request.promise,
    });
    const main = within(view.getByRole('main'));
    const token = main.getByLabelText<HTMLInputElement>('Token');
    await person().type(token, 'ghp_example');
    await person().click(main.getByRole('button', { name: 'Replace token' }));
    expect(token.readOnly).toBe(true);
    expect(main.getByRole<HTMLButtonElement>('button', { name: 'Disconnect' }).disabled).toBe(true);
    request.resolve(connected);
    await settle();
    expect(token.readOnly).toBe(false);
  });

  test('retention cannot be changed again while the first choice is being saved', async () => {
    const request = pending<Awaited<ReturnType<Api['setRetention']>>>();
    const view = await open('data', {
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
      exports: () => Promise.resolve([]),
      setRetention: () => request.promise,
    });
    const card = within(view.getByRole('region', { name: 'History' }));
    const select = card.getByRole<HTMLSelectElement>('combobox');
    await person().selectOptions(select, '365');
    await person().click(card.getByRole('button'));
    expect(select.disabled).toBe(true);
    request.reject(new ApiError(0, 'NETWORK', 'offline'));
    await settle();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('365');
  });

  test('a member role change holds that person’s controls and prevents conflicting removal', async () => {
    const request = pending<Awaited<ReturnType<Api['updateMemberRole']>>>();
    const view = await open('members', {
      members: () => Promise.resolve(someMembers()),
      updateMemberRole: () => request.promise,
    });
    const main = within(view.getByRole('main'));
    const role = main.getByRole<HTMLSelectElement>('combobox', { name: 'Role of Alice' });
    await person().selectOptions(role, 'admin');
    expect(role.disabled).toBe(true);
    expect(main.getByRole<HTMLButtonElement>('button', { name: 'Remove Alice' }).disabled).toBe(
      true,
    );
    expect(main.getByRole<HTMLSelectElement>('combobox', { name: 'Role of Bob' }).disabled).toBe(
      false,
    );
    const alice = someMembers().find((member) => member.user.username === 'alice');
    if (alice === undefined) throw new Error('missing Alice');
    request.resolve(alice);
    await settle();
    expect(role.disabled).toBe(false);
  });
});

test('a restored channel leaves the archive immediately while the refresh is pending', async () => {
  const refresh = pending<Awaited<ReturnType<Api['archivedChannels']>>>();
  let reads = 0;
  const view = await open('general', {
    archivedChannels: () => {
      reads += 1;
      return reads === 1
        ? Promise.resolve([{ id: IDS.api, name: 'old', type: 'public', archivedAt: WHEN }])
        : refresh.promise;
    },
    restoreChannel: () => Promise.resolve(),
  });
  const card = within(view.getByRole('region', { name: 'Archived channels' }));
  await person().click(card.getByRole('button', { name: 'Restore' }));
  await settle();
  expect(card.queryByRole('button', { name: 'Restore' })).toBeNull();
  refresh.resolve([]);
  await settle();
});

test('an audit refresh error remains visible with the cached log and Retry', async () => {
  let failed = false;
  const view = await open('audit', {
    audit: () =>
      failed
        ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
        : Promise.resolve({ data: [], nextCursor: null }),
  });
  failed = true;
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: keys.audit(IDS.workspace, {}) });
  });
  await settle();
  expect(view.getByRole('alert').textContent).toContain('The audit log could not be refreshed.');
  const main = within(view.getByRole('main'));
  failed = false;
  await person().click(main.getByRole('button', { name: 'Retry' }));
  await settle();
  expect(main.queryByRole('alert')).toBeNull();
});

test('changing the profile time zone updates cached quiet hours immediately', async () => {
  const session = aSession();
  let timeZone = 'Europe/Istanbul';
  const view = await open('profile', {
    me: () => Promise.resolve({ ...session, profile: { title: null, status: null, timeZone } }),
    quietHours: () => Promise.resolve({ ...quiet, timeZone }),
    updateProfile: () => {
      timeZone = 'Asia/Tokyo';
      return Promise.resolve({ title: null, status: null, timeZone });
    },
  });
  view.world.client.setQueryData(keys.quietHours, quiet);
  const main = within(view.getByRole('main'));
  const zone = main.getByRole('combobox', { name: 'Time zone' });
  await person().clear(zone);
  await person().type(zone, 'Asia/Tokyo');
  await person().click(main.getByRole('button', { name: 'Save' }));
  await settle();
  expect(view.world.client.getQueryData<QuietHoursSetting>(keys.quietHours)?.timeZone).toBe(
    'Asia/Tokyo',
  );
});

test('a profile refreshed after another device changed its time zone updates cached quiet hours', async () => {
  const session = aSession();
  let timeZone = 'Europe/Istanbul';
  const view = await open('profile', {
    me: () => Promise.resolve({ ...session, profile: { title: null, status: null, timeZone } }),
    quietHours: () => Promise.resolve({ ...quiet, timeZone }),
  });
  view.world.client.setQueryData(keys.quietHours, quiet);
  timeZone = 'Asia/Tokyo';
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: keys.me });
  });
  await settle();
  expect(view.world.client.getQueryData<QuietHoursSetting>(keys.quietHours)?.timeZone).toBe(
    'Asia/Tokyo',
  );
});
