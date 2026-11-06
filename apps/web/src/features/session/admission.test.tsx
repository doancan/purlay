import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { ApiError } from '../../data/errors';
import { AdmissionScreen, InstanceIdentity } from './admission';
import { SessionGate } from './session';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';

installDom();
const signedOut = (): Promise<never> =>
  Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.'));

describe('account admission gate', () => {
  test('pending accounts see their own state without mounting private application content, then refresh into the app after approval', async () => {
    let approved = false;
    const view = await renderApp(
      <SessionGate>
        <p>Private workspace content</p>
      </SessionGate>,
      {
        path: '/',
        api: aSignedInApi({
          me: () => (approved ? Promise.resolve(aSession()) : signedOut()),
          ownAdmission: () => Promise.resolve({ state: approved ? 'approved' : 'pending' }),
        }),
      },
    );
    expect(
      await view.findByRole('heading', { name: 'Your account is awaiting approval' }),
    ).toBeDefined();
    expect(view.queryByText('Private workspace content')).toBeNull();
    expect(view.world.history.stack.at(-1)).toBe('/');
    await expectNoAxeViolations(view.container);
    approved = true;
    await person().click(view.getByRole('button', { name: 'Refresh' }));
    expect(await view.findByText('Private workspace content')).toBeDefined();
    view.unmount();
  });

  test('a status outage offers Retry and does not pretend the session ended', async () => {
    let recovered = false;
    const view = await renderApp(
      <SessionGate>
        <p>Private</p>
      </SessionGate>,
      {
        path: '/server',
        api: aSignedInApi({
          me: () => (recovered ? Promise.resolve(aSession()) : signedOut()),
          ownAdmission: () => Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'Busy')),
        }),
      },
    );
    expect(await view.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(view.queryByText('Private')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.world.history.stack.at(-1)).toBe('/server');
    recovered = true;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('Private')).toBeDefined();
    view.unmount();
  });
});

test.each(['denied', 'verify-email'] as const)(
  '%s explains the restriction, public identity, and allows a failed sign-out to be retried',
  async (state) => {
    let fail = true;
    let refreshes = 0;
    const view = await renderApp(
      <AdmissionScreen
        state={state}
        refresh={() => {
          refreshes++;
        }}
        refreshing={false}
      />,
      {
        path: '/',
        api: aSignedInApi({
          instanceInfo: () =>
            Promise.resolve({
              displayName: 'Research server',
              supportUrl: 'mailto:help@example.test',
              allowedEmailDomains: ['example.test'],
              requireAccountApproval: true,
            }),
          signOut: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()),
        }),
      },
    );
    expect(await view.findByText('Research server')).toBeDefined();
    expect(view.getByRole('link', { name: 'Contact support' }).getAttribute('href')).toBe(
      'mailto:help@example.test',
    );
    await person().click(view.getByRole('button', { name: 'Refresh' }));
    expect(refreshes).toBe(1);
    await person().click(view.getByRole('button', { name: 'Sign out' }));
    expect(await view.findByRole('alert')).toBeDefined();
    fail = false;
    await person().click(view.getByRole('button', { name: 'Sign out' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.world.history.stack.at(-1)).toBe('/sign-in');
    view.unmount();
  },
);

test('the default public identity has no empty layout slot; joining requirements still render without custom branding', async () => {
  const empty = await renderApp(<InstanceIdentity />, { api: aSignedInApi() });
  await act(async () => {
    await Promise.resolve();
  });
  expect(empty.container.textContent).toBe('');
  expect(empty.container.childElementCount).toBe(0);
  empty.unmount();
  const requirements = await renderApp(<InstanceIdentity />, {
    api: aSignedInApi({
      instanceInfo: () =>
        Promise.resolve({
          displayName: 'Purlay',
          supportUrl: null,
          allowedEmailDomains: ['example.test'],
          requireAccountApproval: true,
        }),
    }),
  });
  expect(await requirements.findByText(/example.test/)).toBeDefined();
  expect(requirements.getByText('New accounts need administrator approval.')).toBeDefined();
  requirements.unmount();
});
