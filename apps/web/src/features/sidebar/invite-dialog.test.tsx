/**
 * Invite people (D-115, `UX.md` §2, §8), through the real frame: who is offered it, making a link and
 * copying it, the open links and revoking one, and each state of the list.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { CreatedInvitation, Invitation, InvitationPage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, ME, WHEN, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { Toaster } from '../../ui/toast';
import { ContentPortsContext, type ContentPorts } from '../content/content-ports';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';

installDom();

const TOKEN = 'e'.repeat(64);
const UNTIL = '2026-09-16T08:00:00.000Z';
const anInvitation = (id: string): Invitation => ({
  id,
  createdBy: ME,
  createdAt: WHEN,
  expiresAt: UNTIL,
});
const page = (...data: Invitation[]): InvitationPage => ({ data, nextCursor: null });

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const refusingClipboard: ContentPorts = {
  highlight: () => Promise.resolve(null),
  copy: () => Promise.reject(new Error('the clipboard is not allowed here')),
};

const openDialog = async (
  api: Partial<Api>,
  role: 'owner' | 'admin' | 'member' = 'owner',
  ports?: ContentPorts,
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(
    <>
      {ports === undefined ? (
        <Outlet />
      ) : (
        <ContentPortsContext.Provider value={ports}>
          <Outlet />
        </ContentPortsContext.Provider>
      )}
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

describe('invite people', () => {
  test('an owner makes a link, sees it whole once, copies it, and the open links are read again', async () => {
    const lists = [page(), page(anInvitation('01a0860a-0a00-75f1-9438-ca8bd4a21ae5'))];
    let made = 0;
    const view = await openDialog({
      invitations: () => Promise.resolve(lists[Math.min(made, 1)] ?? page()),
      createInvitation: (workspaceId): Promise<CreatedInvitation> => {
        expect(workspaceId).toBe(IDS.workspace);
        made += 1;
        return Promise.resolve({ invitation: anInvitation('x'), token: TOKEN });
      },
    });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    expect(view.getByRole('dialog', { name: 'Invite people to acme-eng' })).toBeDefined();
    expect(view.getByText('No links are open.')).toBeDefined();
    await expectNoAxeViolations(view.getByRole('dialog'));

    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    const link = view.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite#${TOKEN}`);
    expect(view.getByText(/Made by Dogancan, open until/)).toBeDefined();
    // user-event puts a clipboard of its own on the page; what was written is read back from it.
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(await navigator.clipboard.readText()).toBe(link.value);
  });

  test('revoking a link asks for that one and reads the list again', async () => {
    const id = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
    let revoked: string[] = [];
    const view = await openDialog({
      invitations: () => Promise.resolve(revoked.length === 0 ? page(anInvitation(id)) : page()),
      revokeInvitation: (workspaceId, invitationId) => {
        revoked = [...revoked, `${workspaceId}/${invitationId}`];
        return Promise.resolve();
      },
    });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(revoked).toEqual([`${IDS.workspace}/${id}`]);
    expect(view.getByText('No links are open.')).toBeDefined();
  });

  test('each Revoke says which link it ends: the row it stands in is its description, whole', async () => {
    const first = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
    const second = '01a0860a-0a00-75f1-9438-ca8bd4a21ae6';
    const view = await openDialog({
      invitations: () =>
        Promise.resolve(
          page(anInvitation(first), {
            ...anInvitation(second),
            createdBy: null,
          }),
        ),
    });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    const buttons = view.getAllByRole('button', { name: 'Revoke' });
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

  test('a member is not offered it', async () => {
    const view = await openDialog({}, 'member');
    expect(view.queryByRole('menuitem', { name: 'Invite people…' })).toBeNull();
  });

  test('an admin is', async () => {
    const view = await openDialog({ invitations: () => Promise.resolve(page()) }, 'admin');
    expect(view.getByRole('menuitem', { name: 'Invite people…' })).toBeDefined();
  });

  test('a list that will not load says why with Retry; a link that cannot be made says so', async () => {
    let reads = 0;
    const view = await openDialog({
      invitations: async () => {
        reads += 1;
        if (reads === 1) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(page());
      },
      createInvitation: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
    });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('No links are open.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Could not make a link.');
  });

  test('while the list is read it is a status', async () => {
    const view = await openDialog({ invitations: () => new Promise(() => undefined) });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    expect(view.getByRole('dialog').querySelector('[role="status"]')).not.toBeNull();
  });

  test('a link is shown once: closed and opened again, it is gone; a refused revocation is said', async () => {
    const id = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
    const view = await openDialog({
      invitations: () => Promise.resolve(page(anInvitation(id))),
      createInvitation: () => Promise.resolve({ invitation: anInvitation(id), token: TOKEN }),
      revokeInvitation: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    });
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(view.getByRole('textbox', { name: 'Invitation link' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(view.getByText(/Could not revoke the link\./)).toBeDefined();

    await person().click(view.getByRole('button', { name: 'Close' }));
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    expect(view.queryByRole('textbox', { name: 'Invitation link' })).toBeNull();
  });

  test('the link selects itself when focused; a clipboard that refuses is said, the link left to copy by hand', async () => {
    const view = await openDialog(
      {
        invitations: () => Promise.resolve(page()),
        createInvitation: () => Promise.resolve({ invitation: anInvitation('x'), token: TOKEN }),
      },
      'owner',
      refusingClipboard,
    );
    await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    const link = view.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement;
    act(() => {
      link.focus();
    });
    expect([link.selectionStart, link.selectionEnd]).toEqual([0, link.value.length]);
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(view.getByText(/Couldn't copy/)).toBeDefined();
  });
});
