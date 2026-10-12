/**
 * The workspace's GitHub connection (D-23, `API.md` §7), through the real frame: who is offered it,
 * the status in each state, saving a token and disconnecting, and every failure said in words.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { GitHubIntegration } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import type { Api } from '../../data/api';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, WHEN, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';

installDom();

const NOT_CONNECTED: GitHubIntegration = { configured: false, updatedAt: null };
const CONNECTED: GitHubIntegration = { configured: true, updatedAt: WHEN };

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (
  api: Partial<Api>,
  role: 'owner' | 'admin' | 'member' = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path: `/w/acme/c/${IDS.api}`,
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
  await person().click(view.getByRole('button', { name: 'Switch workspace' }));
  return view;
};

const openDialog = async (
  api: Partial<Api>,
  role: 'owner' | 'admin' = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await open(api, role);
  await person().click(view.getByRole('menuitem', { name: 'GitHub connection…' }));
  await settle();
  return view;
};

describe('the GitHub connection', () => {
  test('is an owner’s and an admin’s; a member is not offered it', async () => {
    const member = await open({}, 'member');
    expect(member.queryByRole('menuitem', { name: 'GitHub connection…' })).toBeNull();
    member.unmount();
    const admin = await open({}, 'admin');
    expect(admin.getByRole('menuitem', { name: 'GitHub connection…' })).toBeDefined();
  });

  test('not connected, it says links stay links; a token saved is sent whole, said, and the status read again', async () => {
    let status = NOT_CONNECTED;
    const sent: string[] = [];
    const view = await openDialog({
      githubIntegration: () => Promise.resolve(status),
      setGitHubToken: (workspaceId, token) => {
        sent.push(`${workspaceId}:${token}`);
        status = CONNECTED;
        return Promise.resolve();
      },
    });
    expect(view.getByText(/Not connected/)).toBeDefined();
    const field = view.getByLabelText('Token');
    expect(field.getAttribute('type')).toBe('password');
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
    const view = await openDialog({
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
    expect(view.getByText(/Not connected/)).toBeDefined();
    expect(view.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  test('a token with a space is refused in the field before the server hears; the server’s refusal lands there too', async () => {
    let calls = 0;
    const view = await openDialog({
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
    const view = await openDialog({
      githubIntegration: () => Promise.resolve(CONNECTED),
      setGitHubToken: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
      removeGitHubToken: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().type(view.getByLabelText('Token'), 'ghp_kept');
    await person().click(view.getByRole('button', { name: 'Save token' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('The token was not saved.');
    expect((view.getByLabelText('Token') as HTMLInputElement).value).toBe('ghp_kept');
    await person().click(view.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('GitHub was not disconnected.');
  });

  test('a status that will not load says why, with Retry; while it is read it is a status', async () => {
    let reads = 0;
    const view = await openDialog({
      githubIntegration: async () => {
        reads += 1;
        if (reads === 1) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(NOT_CONNECTED);
      },
    });
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText(/Not connected/)).toBeDefined();
    view.unmount();
    const reading = await openDialog({ githubIntegration: () => new Promise(() => undefined) });
    expect(reading.getByRole('dialog').querySelector('[role="status"]')).not.toBeNull();
  });

  test('a token half typed is forgotten when the dialog is closed', async () => {
    const view = await openDialog({ githubIntegration: () => Promise.resolve(NOT_CONNECTED) });
    await person().type(view.getByLabelText('Token'), 'ghp_half');
    await person().keyboard('{Escape}');
    await settle();
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'GitHub connection…' }));
    await settle();
    expect((view.getByLabelText('Token') as HTMLInputElement).value).toBe('');
  });

  test('passes the accessibility audit', async () => {
    const view = await openDialog({ githubIntegration: () => Promise.resolve(CONNECTED) });
    await expectNoAxeViolations(view.getByRole('dialog'));
  });
});
