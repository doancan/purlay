/**
 * The workspace's GitHub connection (D-23, `API.md` §7, D-146), through the real frame at the
 * Integrations page's address: who is offered it, the status in each state, saving a token and
 * disconnecting, and every failure said in words.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { GitHubIntegration, UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import { ApiError } from '../../../data/errors';
import type { Api } from '../../../data/api';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { IDS, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const NOT_CONNECTED: GitHubIntegration = { configured: false, updatedAt: null };
const CONNECTED: GitHubIntegration = { configured: true, updatedAt: WHEN };

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const render = async (path: string, api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path,
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            memberships: session.memberships.map((m) => ({ ...m, role })),
          }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

const openPage = async (api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const view = await render('/w/acme/settings/integrations', api, role);
  await view.findByRole('heading', { level: 1, name: 'Integrations' });
  await settle();
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));

describe('the GitHub connection', () => {
  test('is an owner’s and an admin’s; a member is not offered it, and its address is not found', async () => {
    const member = await render('/w/acme/settings/integrations', {}, 'member');
    expect(await member.findByText('Nothing here')).toBeDefined();
    expect(member.queryByRole('link', { name: 'Integrations' })).toBeNull();
    member.unmount();
    const admin = await openPage(
      { githubIntegration: () => Promise.resolve(NOT_CONNECTED) },
      'admin',
    );
    expect(admin.getByRole('link', { name: 'Integrations' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('not connected, it says links stay links; a token saved is sent whole, said, and the status read again', async () => {
    let status = NOT_CONNECTED;
    const sent: string[] = [];
    const view = await openPage({
      githubIntegration: () => Promise.resolve(status),
      setGitHubToken: (workspaceId, token) => {
        sent.push(`${workspaceId}:${token}`);
        status = CONNECTED;
        return Promise.resolve();
      },
    });
    expect(view.getByText(/^Not connected: links/)).toBeDefined();
    const field = view.getByLabelText('Token');
    expect(field.getAttribute('type')).toBe('password');
    // The empty field shows the shape a token has, so the right kind is pasted.
    expect(field.getAttribute('placeholder')).toBe('github_pat_…');
    await person().type(field, '  github_pat_abc123  ');
    await person().click(view.getByRole('button', { name: 'Save token' }));
    await settle();
    expect(sent).toEqual([`${IDS.workspace}:github_pat_abc123`]);
    expect(view.getByText(/Connected since/)).toBeDefined();
    expect((view.getByLabelText('Token') as HTMLInputElement).value).toBe('');
    expect(view.getByText('The token was saved.')).toBeDefined();
  });

  test('connected, it can be disconnected, and the status is read again', async () => {
    let status = CONNECTED;
    let removed = 0;
    const view = await openPage({
      githubIntegration: () => Promise.resolve(status),
      removeGitHubToken: () => {
        removed += 1;
        status = NOT_CONNECTED;
        return Promise.resolve();
      },
    });
    expect(view.getByText(/Connected since/)).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(removed).toBe(1);
    expect(view.getByText(/^Not connected: links/)).toBeDefined();
    expect(view.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  test('a token with a space is refused in the field before the server hears; the server’s refusal lands there too', async () => {
    let calls = 0;
    const view = await openPage({
      githubIntegration: () => Promise.resolve(NOT_CONNECTED),
      setGitHubToken: () => {
        calls += 1;
        return Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'token'));
      },
    });
    await person().type(view.getByLabelText('Token'), 'two words');
    await person().click(view.getByRole('button', { name: 'Save token' }));
    await settle();
    expect(calls).toBe(0);
    expect(view.getByLabelText('Token').getAttribute('aria-invalid')).toBe('true');
    await person().clear(view.getByLabelText('Token'));
    await person().type(view.getByLabelText('Token'), 'ghp_x');
    await person().click(view.getByRole('button', { name: 'Save token' }));
    await settle();
    expect(calls).toBe(1);
    expect(view.getByLabelText('Token').getAttribute('aria-invalid')).toBe('true');
  });

  test('a save or a disconnect that fails is said, and what was typed stays', async () => {
    const view = await openPage({
      githubIntegration: () => Promise.resolve(CONNECTED),
      setGitHubToken: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
      removeGitHubToken: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().type(view.getByLabelText('Token'), 'ghp_kept');
    // Connected, saving a token replaces the one there is.
    await person().click(view.getByRole('button', { name: 'Replace token' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('The token was not saved.');
    expect((view.getByLabelText('Token') as HTMLInputElement).value).toBe('ghp_kept');
    await person().click(view.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('GitHub was not disconnected.');
  });

  test('a status that will not load says why, with Retry; while it is read it is a status', async () => {
    let reads = 0;
    const view = await openPage({
      githubIntegration: async () => {
        reads += 1;
        if (reads === 1) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(NOT_CONNECTED);
      },
    });
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText(/^Not connected: links/)).toBeDefined();
    view.unmount();
    const reading = await openPage({ githubIntegration: () => new Promise(() => undefined) });
    expect(reading.getByRole('main').querySelector('[role="status"]')).not.toBeNull();
  });

  test('nothing typed, there is nothing to save', async () => {
    const view = await openPage({ githubIntegration: () => Promise.resolve(NOT_CONNECTED) });
    expect(main(view).getByRole('button', { name: 'Save token' })).toHaveProperty('disabled', true);
  });

  test('a token half typed is forgotten when the page is left', async () => {
    const view = await openPage({ githubIntegration: () => Promise.resolve(NOT_CONNECTED) });
    await person().type(view.getByLabelText('Token'), 'ghp_half');
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    await person().click(view.getByRole('link', { name: 'Integrations' }));
    await view.findByRole('heading', { level: 1, name: 'Integrations' });
    await settle();
    expect((view.getByLabelText('Token') as HTMLInputElement).value).toBe('');
  });

  test('passes the accessibility audit', async () => {
    const view = await openPage({ githubIntegration: () => Promise.resolve(CONNECTED) });
    await expectNoAxeViolations(view.getByRole('main'));
  });
});
