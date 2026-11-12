/** Linking is explicit; a company session never opens global credentials or devices. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type { MyCompanyIdentity } from '@purlay/types/workspace-identity';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { aSession, aSignedInApi, IDS, WHEN } from '../../testing/fixtures';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import { leave } from '../sign-in/leave';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';

installDom();
const views: Awaited<ReturnType<typeof renderApp>>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});
const identity: MyCompanyIdentity = {
  connectionId: IDS.deploys,
  revision: IDS.bob,
  name: 'Office',
  available: true,
  bindingId: null,
  linkedAt: null,
};
const open = async (
  overrides: Partial<Api> = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/account',
    api: aSignedInApi({
      me: () => Promise.resolve({ ...aSession(), companySignInAvailable: true }),
      myExports: () => Promise.resolve([]),
      myCompanyIdentities: () => Promise.resolve({ data: [identity], nextCursor: null }),
      ...overrides,
    }),
  });
  views.push(view);
  await view.findByRole('heading', { level: 1, name: 'Sessions & account' });
  return view;
};

test('own linking carries the observed connection revision into native OAuth', async () => {
  const asked: unknown[] = [];
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open({
      startCompanyIdentity: (input) => {
        asked.push(input);
        return Promise.resolve({ url: 'https://identity.example/authorize' });
      },
    });
    await person().click(await view.findByRole('button', { name: 'Link identity' }));
    expect(asked).toEqual([
      {
        workspaceId: IDS.workspace,
        connectionId: identity.connectionId,
        revision: identity.revision,
        intent: 'link',
      },
    ]);
    expect(navigation.mock.calls).toEqual([['https://identity.example/authorize']]);
  } finally {
    navigation.mockRestore();
  }
});

test('own identity history pages by the server cursor; unlink requires confirmation and its exact observed binding', async () => {
  const asked: unknown[] = [];
  let linked = true;
  const view = await open({
    myCompanyIdentities: (workspace, query) => {
      asked.push({ workspace, query });
      return Promise.resolve(
        query?.before === IDS.deploys
          ? {
              data: [{ ...identity, connectionId: IDS.api, name: 'Old office', available: false }],
              nextCursor: null,
            }
          : {
              data: [
                {
                  ...identity,
                  bindingId: linked ? IDS.alice : null,
                  linkedAt: linked ? WHEN : null,
                },
              ],
              nextCursor: linked ? IDS.deploys : null,
            },
      );
    },
    unlinkCompanyIdentity: (workspace, connection, binding) => {
      asked.push({ workspace, connection, binding });
      linked = false;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Load more identities' }));
  await view.findByRole('heading', { name: 'Old office' });
  expect(asked).toContainEqual({ workspace: IDS.workspace, query: { before: IDS.deploys } });
  await person().click(view.getByRole('button', { name: 'Unlink identity' }));
  const dialog = view.getByRole('dialog', { name: 'Unlink Office?' });
  expect(linked).toBe(true);
  await expectNoAxeViolations(dialog);
  await person().click(within(dialog).getByRole('button', { name: 'Unlink identity' }));
  await view.findByRole('button', { name: 'Link identity' });
  expect(asked).toContainEqual({
    workspace: IDS.workspace,
    connection: IDS.deploys,
    binding: IDS.alice,
  });
});

test('a company session shows its scope and an independent route, without querying any global account inventory', async () => {
  const reads: string[] = [];
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open({
      me: () =>
        Promise.resolve({
          ...aSession(),
          companyWorkspaceId: IDS.workspace,
          companySignInAvailable: true,
        }),
      mySignIn: () => {
        reads.push('credentials');
        return Promise.reject(new Error('Global credentials requested'));
      },
      mySessions: () => {
        reads.push('devices');
        return Promise.reject(new Error('Global devices requested'));
      },
      myExports: () => {
        reads.push('exports');
        return Promise.reject(new Error('Global export requested'));
      },
    });
    await view.findByRole('heading', { name: 'Signed in with a company identity' });
    expect(
      ((await view.findByRole('button', { name: 'Link identity' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(reads).toEqual([]);
    expect(view.queryByRole('button', { name: 'Erase my account…' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'Sign in to your account' }));
    expect(navigation.mock.calls).toEqual([['/sign-in?independent=1']]);
    await expectNoAxeViolations(view.getByRole('main'));
  } finally {
    navigation.mockRestore();
  }
});

test('a held company session asks for an independent sign-in instead of enrolling global MFA', async () => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/account',
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...aSession(),
          mustEnrolTwoFactor: true,
          companyWorkspaceId: IDS.workspace,
          companySignInAvailable: true,
        }),
    }),
  });
  views.push(view);
  await view.findByRole('heading', { name: 'Signed in with a company identity' });
  expect(view.queryByLabelText('Current password')).toBeNull();
  expect(view.getByRole('button', { name: 'Sign in to your account' })).toBeDefined();
});

test('a refused unlink reports inside its dialog without hiding the retained binding', async () => {
  const view = await open({
    myCompanyIdentities: () =>
      Promise.resolve({
        data: [{ ...identity, bindingId: IDS.alice, linkedAt: WHEN }],
        nextCursor: null,
      }),
    unlinkCompanyIdentity: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
  });
  await person().click(await view.findByRole('button', { name: 'Unlink identity' }));
  const dialog = view.getByRole('dialog');
  await person().click(within(dialog).getByRole('button', { name: 'Unlink identity' }));
  expect(await within(dialog).findByRole('alert')).toBeDefined();
});

test('an unavailable identity inventory can retry, and a failed link never navigates away', async () => {
  let failed = true;
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open({
      myCompanyIdentities: () =>
        failed
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ data: [identity], nextCursor: null }),
      startCompanyIdentity: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const card = within(view.getByRole('region', { name: 'Your company identities' }));
    await card.findByRole('alert');
    failed = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    await person().click(await card.findByRole('button', { name: 'Link identity' }));
    await card.findByRole('alert');
    expect(navigation.mock.calls).toEqual([]);
    expect(card.getByRole<HTMLButtonElement>('button', { name: 'Link identity' }).disabled).toBe(
      false,
    );
  } finally {
    navigation.mockRestore();
  }
});

test('company profile is read-only and never writes canonical profile fields', async () => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/profile',
    api: aSignedInApi({
      me: () => Promise.resolve({ ...aSession(), companyWorkspaceId: IDS.workspace }),
      updateProfile: () =>
        Promise.reject(new Error('Company session attempted a global profile change')),
    }),
  });
  views.push(view);
  await view.findByRole('heading', { name: 'Signed in with a company identity' });
  expect(view.getByRole('main').textContent).toContain(aSession().user.displayName);
  expect(within(view.getByRole('main')).queryByRole('textbox')).toBeNull();
});

test('cancelling an unlink keeps the binding and an empty refreshed inventory has a useful state', async () => {
  let entries: MyCompanyIdentity[] = [{ ...identity, bindingId: IDS.alice, linkedAt: WHEN }];
  let writes = 0;
  const view = await open({
    myCompanyIdentities: () => Promise.resolve({ data: entries, nextCursor: null }),
    unlinkCompanyIdentity: () => {
      writes++;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Unlink identity' }));
  await person().click(
    within(view.getByRole('dialog')).getByText('Cancel', { selector: 'button' }),
  );
  await person().click(view.getByRole('button', { name: 'Unlink identity' }));
  await person().keyboard('{Escape}');
  expect(writes).toBe(0);
  expect(view.queryByRole('dialog') === null).toBe(true);
  entries = [];
  await act(async () => {
    await view.world.client.invalidateQueries({
      queryKey: keys.myCompanyIdentities(IDS.workspace, IDS.me),
    });
  });
  await view.findByText(
    'No company provider is available in this workspace. Ask an administrator to configure one.',
  );
  expect(view.queryByRole('button', { name: 'Unlink identity' }) === null).toBe(true);
});

test('the company account page signs out only this device through the normal logout action', async () => {
  let signedIn = true;
  let calls = 0;
  const view = await open({
    me: () =>
      signedIn
        ? Promise.resolve({
            ...aSession(),
            companyWorkspaceId: IDS.workspace,
            companySignInAvailable: true,
          })
        : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'signed out')),
    signOut: () => {
      calls++;
      signedIn = false;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Sign out' }));
  await waitFor(() => {
    expect(calls).toBe(1);
  });
});
