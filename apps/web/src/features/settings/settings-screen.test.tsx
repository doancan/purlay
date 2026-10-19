/**
 * Settings as a place (D-146), through the real frame: the navigation in the sidebar's place, which
 * pages each role is offered, the page you are on marked, the bare address opening Profile, and an
 * address that names no page — or one this person may not open — not found.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { UserRole } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const ACCOUNT = [
  'Profile',
  'Preferences',
  'Notifications',
  'Keyboard shortcuts',
  'Sessions & account',
];
const WORKSPACE = ['General', 'Members', 'Invitations', 'Integrations', 'Audit log'];

const open = async (path: string, role: UserRole = 'owner'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
    }),
  });
  await settle();
  await view.findByRole('navigation', { name: 'Settings' });
  await settle();
  return view;
};

const nav = (view: View): Scope => within(view.getByRole('navigation', { name: 'Settings' }));

/** Each group's heading and the pages under it, in order. */
const groups = (view: View): [string, string[]][] =>
  nav(view)
    .getAllByRole('list')
    .map((list) => [
      list.previousElementSibling?.textContent ?? '',
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ]);

describe('the settings’ navigation', () => {
  test('an owner is offered every page: theirs, then the workspace’s, Data & retention last', async () => {
    const view = await open('/w/acme/settings/profile');
    expect(groups(view)).toEqual([
      ['Account', ACCOUNT],
      ['acme-eng', [...WORKSPACE, 'Data & retention']],
    ]);
    await expectNoAxeViolations(view.getByRole('complementary'));
    view.unmount();
  });

  test('an admin, the workspace’s pages without Data & retention, which is an owner’s', async () => {
    const view = await open('/w/acme/settings/profile', 'admin');
    expect(groups(view)).toEqual([
      ['Account', ACCOUNT],
      ['acme-eng', WORKSPACE],
    ]);
    view.unmount();
  });

  test('a member, their own pages and no workspace group at all', async () => {
    const view = await open('/w/acme/settings/profile', 'member');
    expect(groups(view)).toEqual([['Account', ACCOUNT]]);
    expect(nav(view).queryByText('acme-eng')).toBeNull();
    view.unmount();
  });

  test('marks the page you are on, and only it; following a link moves the mark', async () => {
    const view = await open('/w/acme/settings/preferences');
    const current = (): string[] =>
      nav(view)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);
    expect(current()).toEqual(['Preferences']);
    await person().click(nav(view).getByRole('link', { name: 'Keyboard shortcuts' }));
    expect(
      await view.findByRole('heading', { level: 1, name: 'Keyboard shortcuts' }),
    ).toBeDefined();
    expect(current()).toEqual(['Keyboard shortcuts']);
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/shortcuts');
    view.unmount();
  });

  test('leads back to the workspace by name', async () => {
    const view = await open('/w/acme/settings/profile');
    const back = nav(view).getByRole('link', { name: 'Back to acme-eng' });
    expect(back.getAttribute('href')).toBe('/w/acme');
    view.unmount();
  });

  test('takes the sidebar’s place: no channels, and the account menu stays at the foot', async () => {
    const view = await open('/w/acme/settings/profile');
    const sidebar = within(view.getByRole('complementary'));
    expect(sidebar.queryByRole('button', { name: /^acme-eng/ })).toBeNull();
    expect(sidebar.queryByText('api')).toBeNull();
    expect(sidebar.getByRole('button', { name: 'Account: Dogancan' })).toBeDefined();
    view.unmount();
  });
});

describe('a settings address', () => {
  test('/w/acme/settings opens Profile, marked as the page you are on', async () => {
    const view = await open('/w/acme/settings');
    expect(await view.findByRole('heading', { level: 1, name: 'Profile' })).toBeDefined();
    expect(nav(view).getByRole('link', { name: 'Profile' }).getAttribute('aria-current')).toBe(
      'page',
    );
    view.unmount();
  });

  test('that names no page is not found', async () => {
    const view = await open('/w/acme/settings/billing');
    expect(await view.findByText('Nothing here')).toBeDefined();
    expect(view.queryByRole('heading', { level: 1, name: 'Profile' })).toBeNull();
    // The navigation stays, so the way to a page that exists is still there.
    expect(nav(view).getByRole('link', { name: 'Profile' })).toBeDefined();
    view.unmount();
  });

  test('of a page this person may not open is not found, as any address is', async () => {
    const view = await open('/w/acme/settings/data', 'admin');
    expect(await view.findByText('Nothing here')).toBeDefined();
    expect(view.queryByRole('heading', { level: 1, name: 'Data & retention' })).toBeNull();
    view.unmount();
  });

  test('of the shortcut reference shows it as a page', async () => {
    const view = await open('/w/acme/settings/shortcuts');
    expect(
      await view.findByRole('heading', { level: 1, name: 'Keyboard shortcuts' }),
    ).toBeDefined();
    expect(within(view.getByRole('main')).getAllByRole('heading').length).toBeGreaterThan(1);
    view.unmount();
  });

  test('of the shortcut reference passes the accessibility audit', async () => {
    const view = await open('/w/acme/settings/shortcuts');
    await view.findByRole('heading', { level: 1, name: 'Keyboard shortcuts' });
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });
});
