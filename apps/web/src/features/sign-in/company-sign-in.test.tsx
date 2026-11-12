/** Public exact lookup and native redirection are exercised through the real sign-in screen. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, waitFor } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { aSession, IDS } from '../../testing/fixtures';
import { COMPANY_METHODS } from '../../testing/company-identity';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import { leave } from './leave';

installDom();
const views: Awaited<ReturnType<typeof renderApp>>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});
const open = async (
  overrides: Partial<Api> = {},
  path = '/sign-in?workspace=acme',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path,
    api: anApi({
      me: () => {
        return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'signed out'));
      },
      authMethods: () => Promise.resolve(COMPANY_METHODS),
      companySignInOptions: (workspace) =>
        Promise.resolve({
          workspace,
          connections: [{ id: IDS.api, name: 'Office' }],
        }),
      ...overrides,
    }),
  });
  views.push(view);
  await view.findByRole('heading', { name: 'Sign in with your company' });
  return view;
};

test('normalizes an exact workspace address and starts only the selected native provider', async () => {
  const asked: unknown[] = [];
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open(
      {
        companySignInOptions: (workspace) => {
          asked.push(workspace);
          return Promise.resolve({ workspace, connections: [{ id: IDS.api, name: 'Office' }] });
        },
        signInWithCompany: (input) => {
          asked.push(input);
          return Promise.resolve({ url: 'https://identity.example/authorize' });
        },
      },
      '/sign-in?workspace=ACME',
    );
    expect(asked).toEqual([]);
    await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
    await person().click(await view.findByRole('button', { name: 'Continue with Office' }));
    expect(asked).toEqual(['acme', { workspace: 'acme', connectionId: IDS.api }]);
    expect(navigation.mock.calls).toEqual([['https://identity.example/authorize']]);
    await expectNoAxeViolations(view.container);
  } finally {
    navigation.mockRestore();
  }
});

test('a provider refusal is an actionable flow error without labelling the valid workspace invalid', async () => {
  const view = await open({
    signInWithCompany: () => {
      return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
    },
  });
  await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
  await person().click(await view.findByRole('button', { name: 'Continue with Office' }));
  await view.findByRole('alert');
  expect(
    view.getByRole('textbox', { name: 'Workspace address' }).getAttribute('aria-invalid'),
  ).not.toBe('true');
  expect(
    (view.getByRole('button', { name: 'Continue with Office' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('a failed company lookup can retry without retaining a provider from another workspace', async () => {
  let failed = true;
  const view = await open({
    companySignInOptions: (workspace) =>
      failed
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve({ workspace, connections: [{ id: IDS.api, name: 'Office' }] }),
  });
  await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
  await view.findByRole('alert');
  expect(view.queryByRole('button', { name: 'Continue with Office' })).toBeNull();
  failed = false;
  await person().click(view.getByRole('button', { name: 'Retry' }));
  await view.findByRole('button', { name: 'Continue with Office' });
  const keyboard = person();
  await keyboard.click(view.getByRole('textbox', { name: 'Workspace address' }));
  await keyboard.keyboard('{End}{Backspace}{Backspace}{Backspace}{Backspace}');
  expect((view.getByRole('textbox', { name: 'Workspace address' }) as HTMLInputElement).value).toBe(
    '',
  );
  await waitFor(() => {
    expect(view.queryByRole('button', { name: 'Continue with Office' }) === null).toBe(true);
  });
});

test('invalid addresses do not query; unavailable workspaces expose no directory', async () => {
  const asked: string[] = [];
  const view = await open(
    {
      companySignInOptions: (workspace) => {
        asked.push(workspace);
        return Promise.resolve({ workspace, connections: [] });
      },
    },
    '/sign-in?workspace=not%20an%20address',
  );
  await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
  expect(
    view.getByRole('textbox', { name: 'Workspace address' }).getAttribute('aria-invalid'),
  ).toBe('true');
  expect(asked).toEqual([]);
  await person().clear(view.getByRole('textbox', { name: 'Workspace address' }));
  await person().type(view.getByRole('textbox', { name: 'Workspace address' }), 'acme');
  await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
  await view.findByText(
    'No active company provider was found for this workspace. Check its address or ask your administrator.',
  );
  expect(asked).toEqual(['acme']);
});

test('an unmounted company sign-in cannot redirect when its pending request completes', async () => {
  let finish: (value: { url: string }) => void = () => {
    throw new Error('Request not started');
  };
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open({
      signInWithCompany: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await person().click(view.getByRole('button', { name: 'Find company sign-in' }));
    await person().click(await view.findByRole('button', { name: 'Continue with Office' }));
    view.unmount();
    await act(() => {
      finish({ url: 'https://identity.example/late' });
      return Promise.resolve();
    });
    expect(navigation.mock.calls).toEqual([]);
  } finally {
    navigation.mockRestore();
  }
});

test('independent sign-in stays available to a company session instead of bouncing back to its workspace', async () => {
  const view = await renderApp(<Outlet />, {
    path: '/sign-in?independent=1',
    api: anApi({
      me: () =>
        Promise.resolve({
          ...aSession(),
          companyWorkspaceId: IDS.workspace,
          companySignInAvailable: true,
        }),
      authMethods: () => Promise.resolve(COMPANY_METHODS),
    }),
  });
  views.push(view);
  await view.findByRole('form', { name: 'Sign in with a password' });
  expect(view.world.history.stack).toEqual(['/sign-in?independent=1']);
  expect(view.queryByRole('heading', { name: 'Sign in with your company' })).toBeNull();
});
