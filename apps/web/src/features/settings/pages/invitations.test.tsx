/**
 * Invitations (D-115, D-146), through the real frame at the page's address: who is offered it, making
 * a link and copying it, the open links and revoking one, and each state of the list.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type {
  CreatedInvitation,
  Invitation,
  InvitationPage as Page,
  UserRole,
} from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { IDS, ME, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const TOKEN = 'e'.repeat(64);
const UNTIL = '2026-09-16T08:00:00.000Z';
const FIRST = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
const SECOND = '01a0860a-0a00-75f1-9438-ca8bd4a21ae6';
const anInvitation = (id: string): Invitation => ({
  id,
  createdBy: ME,
  createdAt: WHEN,
  expiresAt: UNTIL,
});
const page = (...data: Invitation[]): Page => ({ data, nextCursor: null });

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

/** The Invitations page, loaded: its chunk is lazy, so the heading is waited for. */
const openPage = async (api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const view = await render('/w/acme/settings/invitations', api, role);
  await view.findByRole('heading', { level: 1, name: 'Invitations' });
  await settle();
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));

describe('invitations', () => {
  test('are an owner’s and an admin’s; a member is not offered them, and their address is not found', async () => {
    const member = await render('/w/acme/settings/invitations', {}, 'member');
    expect(await member.findByText('Nothing here')).toBeDefined();
    expect(member.queryByRole('link', { name: 'Invitations' })).toBeNull();
    member.unmount();
    const admin = await openPage({ invitations: () => Promise.resolve(page()) }, 'admin');
    expect(admin.getByRole('link', { name: 'Invitations' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('an owner makes a link, sees it whole once, copies it, and the open links are read again', async () => {
    const lists = [page(), page(anInvitation(FIRST))];
    let made = 0;
    const view = await openPage({
      invitations: () => Promise.resolve(lists[Math.min(made, 1)] ?? page()),
      createInvitation: (workspaceId): Promise<CreatedInvitation> => {
        expect(workspaceId).toBe(IDS.workspace);
        made += 1;
        return Promise.resolve({ invitation: anInvitation(FIRST), token: TOKEN });
      },
    });
    expect(main(view).getByText('No links are open.')).toBeDefined();
    await expectNoAxeViolations(view.getByRole('main'));

    await person().click(main(view).getByRole('button', { name: 'Make a link' }));
    await settle();
    const link = main(view).getByRole<HTMLInputElement>('textbox', { name: 'Invitation link' });
    expect(link.value).toBe(`${window.location.origin}/invite#${TOKEN}`);
    expect(main(view).getByText(/Made by Dogancan, open until/)).toBeDefined();
    // user-event puts a clipboard of its own on the page; what was written is read back from it.
    await person().click(main(view).getByRole('button', { name: 'Copy' }));
    await settle();
    expect(await navigator.clipboard.readText()).toBe(link.value);
    expect(view.getByText('Copied')).toBeDefined();
  });

  test('a link is shown once: the page left and opened again, it is gone', async () => {
    const view = await openPage({
      invitations: () => Promise.resolve(page()),
      createInvitation: () => Promise.resolve({ invitation: anInvitation(FIRST), token: TOKEN }),
    });
    await person().click(main(view).getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(main(view).getByRole('textbox', { name: 'Invitation link' })).toBeDefined();
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    await person().click(view.getByRole('link', { name: 'Invitations' }));
    await view.findByRole('heading', { level: 1, name: 'Invitations' });
    expect(main(view).queryByRole('textbox', { name: 'Invitation link' })).toBeNull();
    expect(main(view).getByRole('button', { name: 'Make a link' })).toBeDefined();
  });

  test('revoking a link ends that one and reads the list again', async () => {
    let revoked: string[] = [];
    const view = await openPage({
      invitations: () => Promise.resolve(revoked.length === 0 ? page(anInvitation(FIRST)) : page()),
      revokeInvitation: (workspaceId, invitationId) => {
        revoked = [...revoked, `${workspaceId}/${invitationId}`];
        return Promise.resolve();
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(revoked).toEqual([`${IDS.workspace}/${FIRST}`]);
    expect(main(view).getByText('No links are open.')).toBeDefined();
  });

  test('each Revoke says which link it ends: the row it stands in is its description, whole', async () => {
    const view = await openPage({
      invitations: () =>
        Promise.resolve(page(anInvitation(FIRST), { ...anInvitation(SECOND), createdBy: null })),
    });
    const buttons = main(view).getAllByRole('button', { name: 'Revoke' });
    expect(buttons).toHaveLength(2);
    const described = buttons.map((button) =>
      (button.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => button.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
    expect(described[0]).toMatch(/^Made by .+, open until .+/);
    expect(described[1]).toMatch(/^Made by someone, open until .+/);
  });

  test('a refused revocation is said, and the link stays listed', async () => {
    const view = await openPage({
      invitations: () => Promise.resolve(page(anInvitation(FIRST))),
      revokeInvitation: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().click(main(view).getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(view.getByText(/Could not revoke the link\./)).toBeDefined();
    expect(main(view).getByRole('button', { name: 'Revoke' })).toBeDefined();
  });

  test('a list that will not load says so with Retry; a link that cannot be made says so', async () => {
    let reads = 0;
    const view = await openPage({
      invitations: async () => {
        reads += 1;
        if (reads === 1) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(page());
      },
      createInvitation: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
    });
    expect(main(view).getByText('The open links did not load.')).toBeDefined();
    await person().click(main(view).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(main(view).getByText('No links are open.')).toBeDefined();
    await person().click(main(view).getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(main(view).getByRole('alert').textContent).toContain('Could not make a link.');
  });

  test('while the list is read it is a status', async () => {
    const view = await openPage({ invitations: () => new Promise(() => undefined) });
    expect(view.getByRole('main').querySelector('[role="status"]')).not.toBeNull();
  });
});
