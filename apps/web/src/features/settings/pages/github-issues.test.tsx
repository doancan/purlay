/**
 * GitHub issues, connected (D-246 §1–2), through the real frame: nothing is drawn where the server has no
 * App, an owner's installation card and everybody's own opt-in each say their states and leave for GitHub by
 * the address the server gave, the trip's outcome is said from `?github=`, and a failure is said in words.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { GitHubAppStatus, UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { IDS, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { leave } from '../../sign-in/leave';

installDom();

const OFF: GitHubAppStatus = { available: false, installation: null, authorization: null };
const READY: GitHubAppStatus = { available: true, installation: null, authorization: null };
const INSTALLATION = {
  accountLogin: 'acme',
  accountType: 'Organization',
  suspended: false,
  connectedAt: WHEN,
} as const;
const INSTALLED: GitHubAppStatus = {
  available: true,
  installation: INSTALLATION,
  authorization: { login: 'ayse-dev' },
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (
  path: string,
  heading: string,
  api: Partial<Api>,
  role: UserRole = 'owner',
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
      githubIntegration: () => Promise.resolve({ configured: false, updatedAt: null }),
      ...api,
    }),
  });
  await view.findByRole('heading', { level: 1, name: heading });
  await settle();
  return view;
};

const withLeaving = async (body: () => Promise<void>): Promise<string[]> => {
  const went: string[] = [];
  const original = leave.to;
  leave.to = (url): void => {
    went.push(url);
  };
  try {
    await body();
  } finally {
    leave.to = original;
  }
  return went;
};

describe('the installation card, on Integrations', () => {
  test('is not drawn where the server has no App', async () => {
    const view = await open('/w/acme/settings/integrations', 'Integrations', {
      githubApp: () => Promise.resolve(OFF),
    });
    expect(view.queryByRole('region', { name: 'GitHub issues' })).toBeNull();
    view.unmount();
  });

  test('not installed, it offers to connect and leaves for the address the server gave', async () => {
    const went = await withLeaving(async () => {
      const view = await open('/w/acme/settings/integrations', 'Integrations', {
        githubApp: () => Promise.resolve(READY),
        startGitHubInstallation: (workspaceId) => {
          expect(workspaceId).toBe(IDS.workspace);
          return Promise.resolve({
            url: 'https://github.example/apps/purlay/installations/new?state=s',
          });
        },
      });
      const card = within(view.getByRole('region', { name: 'GitHub issues' }));
      expect(card.getByText('No installation is connected yet.')).toBeDefined();
      expect(card.queryByRole('button', { name: 'Disconnect' })).toBeNull();
      await expectNoAxeViolations(view.getByRole('main'));
      await person().click(card.getByRole('button', { name: 'Connect on GitHub' }));
      await settle();
      view.unmount();
    });
    expect(went).toEqual(['https://github.example/apps/purlay/installations/new?state=s']);
  });

  test('installed, it says where and since when, and disconnects with the status read again', async () => {
    let status = INSTALLED;
    const view = await open('/w/acme/settings/integrations', 'Integrations', {
      githubApp: () => Promise.resolve(status),
      removeGitHubInstallation: () => {
        status = { ...INSTALLED, installation: null };
        return Promise.resolve();
      },
    });
    const card = within(view.getByRole('region', { name: 'GitHub issues' }));
    expect(card.getByText(/Installed on acme since/)).toBeDefined();
    await person().click(card.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(card.getByText('No installation is connected yet.')).toBeDefined();
    view.unmount();
  });

  test('a suspended installation is said, and a failure to connect is said in words', async () => {
    const view = await open('/w/acme/settings/integrations', 'Integrations', {
      githubApp: () =>
        Promise.resolve({
          ...INSTALLED,
          installation: { ...INSTALLATION, suspended: true },
        }),
      startGitHubInstallation: () =>
        Promise.reject(new ApiError(403, 'FORBIDDEN', 'Only an owner connects.')),
    });
    const card = within(view.getByRole('region', { name: 'GitHub issues' }));
    expect(card.getByText(/GitHub has suspended this installation/)).toBeDefined();
    await person().click(card.getByRole('button', { name: 'Connect again' }));
    await settle();
    expect(card.getByRole('alert')).toBeDefined();
    view.unmount();
  });

  test('the trip’s outcome is said from the address GitHub’s return was sent on to', async () => {
    const view = await open('/w/acme/settings/integrations?github=not-yours', 'Integrations', {
      githubApp: () => Promise.resolve(READY),
    });
    expect(view.getByText(/not an installation you own here/)).toBeDefined();
    view.unmount();
  });

  test('is an owner’s and an admin’s page: a member is not offered it', async () => {
    const view = await open('/w/acme/settings/account', 'Sessions & account', {}, 'member');
    expect(view.queryByRole('region', { name: 'GitHub issues' })).toBeNull();
    view.unmount();
  });
});

describe('the person’s own opt-in, on Sessions & account', () => {
  test('is not drawn where the server has no App', async () => {
    const view = await open('/w/acme/settings/account', 'Sessions & account', {});
    expect(view.queryByRole('region', { name: 'Create issues as you' })).toBeNull();
    view.unmount();
  });

  test('off, it says nothing is written as them, and allowing leaves for GitHub, coming back here', async () => {
    const returns: string[] = [];
    const went = await withLeaving(async () => {
      const view = await open(
        '/w/acme/settings/account?github=authorized',
        'Sessions & account',
        {
          githubApp: () => Promise.resolve(READY),
          startGitHubAuthorization: (returnTo) => {
            returns.push(returnTo);
            return Promise.resolve({ url: 'https://github.example/login/oauth/authorize?state=s' });
          },
        },
        'member',
      );
      const card = within(view.getByRole('region', { name: 'Create issues as you' }));
      expect(card.getByText('Not allowed. Purlay writes nothing to GitHub as you.')).toBeDefined();
      await person().click(card.getByRole('button', { name: 'Let Purlay create issues as me' }));
      await settle();
      view.unmount();
    });
    // The last trip's word is not carried into the next one.
    expect(returns).toEqual(['/w/acme/settings/account']);
    expect(went).toEqual(['https://github.example/login/oauth/authorize?state=s']);
  });

  test('allowed, it says as whom, and stopping forgets it and reads the status again', async () => {
    let status = INSTALLED;
    const view = await open('/w/acme/settings/account', 'Sessions & account', {
      githubApp: () => Promise.resolve(status),
      forgetGitHubAuthorization: () => {
        status = { ...INSTALLED, authorization: null };
        return Promise.resolve();
      },
    });
    const card = within(view.getByRole('region', { name: 'Create issues as you' }));
    expect(card.getByText('Allowed, as ayse-dev.')).toBeDefined();
    await expectNoAxeViolations(view.getByRole('main'));
    await person().click(card.getByRole('button', { name: 'Stop allowing' }));
    await settle();
    expect(card.getByText('Not allowed. Purlay writes nothing to GitHub as you.')).toBeDefined();
    view.unmount();
  });

  test('a failure is said, and the choice stays as it was', async () => {
    const view = await open('/w/acme/settings/account', 'Sessions & account', {
      githubApp: () => Promise.resolve(INSTALLED),
      forgetGitHubAuthorization: () =>
        Promise.reject(new ApiError(500, 'INTERNAL', 'Something went wrong.')),
    });
    const card = within(view.getByRole('region', { name: 'Create issues as you' }));
    await person().click(card.getByRole('button', { name: 'Stop allowing' }));
    await settle();
    expect(card.getByRole('alert')).toBeDefined();
    expect(card.getByText('Allowed, as ayse-dev.')).toBeDefined();
    view.unmount();
  });
});
