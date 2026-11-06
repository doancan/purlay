import { describe, expect, test, spyOn } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { ServerOverview, ServerUserPage, ServerWorkspacePage } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { expectNoAxeViolations } from '../../testing/axe';
import { person } from '../../testing/user';
import {
  ADMIN_OVERVIEW,
  ADMIN_PREFERENCES,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
import { createAdministrationClient } from './client';
import { AdministrationClientProvider } from './context';

installDom();
const stamp = '2026-11-06T08:00:00.000Z';
const overview: ServerOverview = {
  checkedAt: stamp,
  version: '0.3.0',
  appUrl: 'https://purlay.test',
  ready: true,
  modules: ['chat'],
  users: 12,
  admins: 2,
  suspendedUsers: 1,
  workspaces: 3,
  deletedWorkspaces: 0,
  usedBytes: '1024',
  storage: 's3',
  pushConfigured: false,
  sharedStateConfigured: false,
  exportFailures: 0,
};
const admin = aSession();
const user: ServerUserPage['data'][number] = {
  id: admin.user.id,
  username: 'ada',
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  admissionState: 'approved',
  isServerAdmin: false,
  createdAt: stamp,
  lastSeenAt: null,
  suspendedAt: null,
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const open = async (
  section: string,
  answer: (path: string, body: unknown) => Response,
  allowed = true,
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const client = createAdministrationClient((input, init) =>
    Promise.resolve(
      input === '/api/server/preferences' && init.body === undefined
        ? json({
            displayName: 'Purlay',
            supportUrl: null,
            allowedEmailDomains: [],
            requireAccountApproval: false,
          })
        : answer(input, init.body),
    ),
  );
  const view = await renderApp(
    <AdministrationClientProvider value={client}>
      <Outlet />
    </AdministrationClientProvider>,
    {
      path: `/server/${section}`,
      api: aSignedInApi({
        me: () => Promise.resolve({ ...admin, isServerAdmin: allowed, memberships: [] }),
      }),
    },
  );
  await settle();
  return view;
};
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

describe('server administration outside a workspace', () => {
  test('an administrator with no memberships sees actual overview and all nine sections', async () => {
    const view = await open('overview', () => json(overview));
    const main = within(await view.findByRole('main'));
    expect(await main.findByText('Database and application readiness checks passed')).toBeDefined();
    expect(main.getByText('0.3.0')).toBeDefined();
    const nav = within(view.getByRole('navigation', { name: 'Administration sections' }));
    expect(nav.getAllByRole('link')).toHaveLength(10);
    expect(nav.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(main.getAllByText('Not configured')).toHaveLength(2);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('an old workspace bookmark reaches the console without membership in that workspace', async () => {
    const client = createAdministrationClient((path) =>
      Promise.resolve(
        json(
          path === '/api/server/preferences'
            ? {
                displayName: 'Purlay',
                supportUrl: null,
                allowedEmailDomains: [],
                requireAccountApproval: false,
              }
            : overview,
        ),
      ),
    );
    const view = await renderApp(
      <AdministrationClientProvider value={client}>
        <Outlet />
      </AdministrationClientProvider>,
      {
        path: '/w/no-longer-a-member/settings/server',
        api: aSignedInApi({
          me: () => Promise.resolve({ ...admin, isServerAdmin: true, memberships: [] }),
        }),
      },
    );
    expect(await view.findByRole('heading', { level: 1, name: 'Overview' })).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe('/server');
    view.unmount();
  });

  test('members and unknown sections mount no administration requests', async () => {
    for (const [section, allowed] of [
      ['overview', false],
      ['made-up', true],
    ] as const) {
      let reads = 0;
      const view = await open(
        section,
        () => {
          reads++;
          return json(overview);
        },
        allowed,
      );
      expect(await view.findByText('Nothing here')).toBeDefined();
      expect(reads).toBe(0);
      view.unmount();
    }
  });

  test('failed reads offer retry; a failed refresh retains the last result with a visible warning', async () => {
    let reads = 0;
    const view = await open('overview', () => {
      reads++;
      return reads === 2
        ? json(overview)
        : json({ error: { code: 'INTERNAL', message: 'unavailable' } }, 500);
    });
    expect(await view.findByText('Could not read administration data')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('0.3.0')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Refresh' }));
    expect(
      await view.findByText('The refresh failed. The last received data is shown below.'),
    ).toBeDefined();
    expect(view.getByText('0.3.0')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    expect(
      await view.findByText('The refresh failed. The last received data is shown below.'),
    ).toBeDefined();
    view.unmount();
  });

  test('user pages follow server cursors and restart after a filter; role changes require explicit confirmation', async () => {
    const calls: string[] = [];
    let granted = false;
    const view = await open('users', (path, body) => {
      calls.push(path);
      if (path.endsWith('/admin')) {
        expect(JSON.parse(String(body))).toEqual({ isServerAdmin: true });
        granted = true;
        return new Response(null, { status: 204 });
      }
      return json({
        data: [user],
        nextCursor: path.includes('after=') ? null : user.id,
      } satisfies ServerUserPage);
    });
    await view.findByText('Ada Lovelace');
    await person().click(view.getByRole('button', { name: 'Next page' }));
    await settle();
    expect(calls.some((path) => path.includes(`after=${user.id}`))).toBe(true);
    await person().type(view.getByLabelText('Search by name, username or email'), 'Ada');
    await person().click(view.getByRole('button', { name: 'Search' }));
    await settle();
    expect(calls.at(-1)).toContain('q=Ada');
    expect(calls.at(-1)).not.toContain('after=');
    await person().click(view.getByRole('button', { name: 'Grant administrator access' }));
    expect(granted).toBe(false);
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Confirm change' }));
    await view.findByText('Change saved');
    expect(granted).toBe(true);
    view.unmount();
  });

  test('workspace quota validation refuses fractional and unsafe numbers before any write', async () => {
    let writes = 0;
    const workspace: ServerWorkspacePage['data'][number] = {
      id: user.id,
      name: 'Research team',
      slug: 'research',
      createdAt: stamp,
      deletedAt: null,
      purgedAt: null,
      memberCount: 4,
      ownerCount: 1,
      owners: [{ id: user.id, displayName: user.displayName }],
      usedBytes: '2048',
      quotaBytes: '1024',
      retentionDays: null,
    };
    const view = await open('workspaces', (path) => {
      if (path.endsWith('/quota')) {
        writes++;
        return new Response(null, { status: 204 });
      }
      return json({ data: [workspace], nextCursor: null } satisfies ServerWorkspacePage);
    });
    await person().click(await view.findByRole('button', { name: 'Change quota' }));
    const dialog = within(view.getByRole('dialog'));
    const field = dialog.getByLabelText('Quota in bytes');
    await person().clear(field);
    await person().type(field, '1.5');
    await person().click(dialog.getByRole('button', { name: 'Save quota' }));
    expect(await dialog.findByRole('alert')).toBeDefined();
    expect(writes).toBe(0);
    await person().clear(field);
    await person().type(field, '512');
    await person().click(dialog.getByRole('button', { name: 'Save quota' }));
    await settle();
    expect(writes).toBe(1);
    view.unmount();
  });
});

test('console navigation closes its menu after changing section and sign-out leaves the console', async () => {
  let signedOut = false;
  const view = await renderAdministration('overview', undefined, {
    api: {
      me: () =>
        signedOut
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.'))
          : Promise.resolve({ ...admin, isServerAdmin: true }),
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    },
  });
  const menu = await view.findByRole('button', { name: 'Sections' });
  await person().click(menu);
  expect(menu.getAttribute('aria-expanded')).toBe('true');
  const nav = within(view.getByRole('navigation', { name: 'Administration sections' }));
  await person().click(nav.getByRole('link', { name: 'Users and administrators' }));
  expect(
    await view.findByRole('heading', { level: 1, name: 'Users and administrators' }),
  ).toBeDefined();
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  await person().click(nav.getByRole('button', { name: 'Sign out' }));
  await settle();
  expect(signedOut).toBe(true);
  expect(view.world.history.stack.at(-1)).toBe('/sign-in');
  view.unmount();
});

test('the console uses the real platform HTTP client when no test provider is supplied', async () => {
  const network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: RequestInfo | URL): Promise<Response> =>
        Promise.resolve(
          adminJson(input === '/api/server/preferences' ? ADMIN_PREFERENCES : ADMIN_OVERVIEW),
        ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const view = await renderApp(<Outlet />, {
      path: '/server',
      api: aSignedInApi({
        me: () => Promise.resolve({ ...admin, isServerAdmin: true, modules: [] }),
      }),
    });
    expect(await view.findByRole('heading', { level: 1, name: 'Overview' })).toBeDefined();
    await settle();
    expect(network).toHaveBeenCalled();
    view.unmount();
  } finally {
    network.mockRestore();
  }
});

test('an administrator with no workspace reaches administration from the home entry', async () => {
  const client = createAdministrationClient((path) =>
    Promise.resolve(json(path === '/api/server/preferences' ? ADMIN_PREFERENCES : ADMIN_OVERVIEW)),
  );
  const view = await renderApp(
    <AdministrationClientProvider value={client}>
      <Outlet />
    </AdministrationClientProvider>,
    {
      path: '/',
      api: aSignedInApi({
        me: () => Promise.resolve({ ...admin, isServerAdmin: true, memberships: [] }),
      }),
    },
  );
  await person().click(await view.findByRole('button', { name: 'Server administration' }));
  expect(await view.findByRole('heading', { level: 1, name: 'Overview' })).toBeDefined();
  view.unmount();
});
