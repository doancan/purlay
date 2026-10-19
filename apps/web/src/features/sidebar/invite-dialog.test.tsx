/**
 * Invite people (D-115, D-146, `UX.md` §2, §8), the quick dialog from the workspace menu, through the
 * real frame: who is offered it, making a link and copying it, the link shown once, and the way to
 * the Invitations page, where the open links are seen and revoked (`settings/pages/invitations.test.tsx`).
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
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

/** The real frame in a channel, with the workspace menu open. */
const openMenu = async (
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

/** The dialog, from the workspace menu. */
const invite = async (view: Awaited<ReturnType<typeof renderApp>>): Promise<HTMLElement> => {
  await person().click(view.getByRole('menuitem', { name: 'Invite people…' }));
  await settle();
  return view.getByRole('dialog', { name: 'Invite people to acme-eng' });
};

describe('invite people', () => {
  test('an owner makes a link, sees it whole once, and copies it, without the open links read', async () => {
    let made = 0;
    let listed = 0;
    const view = await openMenu({
      invitations: () => {
        listed += 1;
        return Promise.resolve(page());
      },
      createInvitation: (workspaceId): Promise<CreatedInvitation> => {
        expect(workspaceId).toBe(IDS.workspace);
        made += 1;
        return Promise.resolve({ invitation: anInvitation('x'), token: TOKEN });
      },
    });
    const dialog = await invite(view);
    await expectNoAxeViolations(dialog);
    // The open links are the Invitations page's: the quick dialog does not read them.
    expect(view.queryByText('No links are open.')).toBeNull();

    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(made).toBe(1);
    const link = view.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite#${TOKEN}`);
    // user-event puts a clipboard of its own on the page; what was written is read back from it.
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(await navigator.clipboard.readText()).toBe(link.value);
    expect(listed).toBe(0);
  });

  test('a member is not offered it', async () => {
    const view = await openMenu({}, 'member');
    expect(view.queryByRole('menuitem', { name: 'Invite people…' })).toBeNull();
  });

  test('an admin is', async () => {
    const view = await openMenu({}, 'admin');
    expect(view.getByRole('menuitem', { name: 'Invite people…' })).toBeDefined();
  });

  test('a link that cannot be made says so', async () => {
    const view = await openMenu({
      createInvitation: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
    });
    await invite(view);
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Could not make a link.');
  });

  test('a link is shown once: closed and opened again, it is gone', async () => {
    const view = await openMenu({
      createInvitation: () => Promise.resolve({ invitation: anInvitation('x'), token: TOKEN }),
    });
    await invite(view);
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(view.getByRole('textbox', { name: 'Invitation link' })).toBeDefined();

    await person().click(view.getByRole('button', { name: 'Close' }));
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await invite(view);
    expect(view.queryByRole('textbox', { name: 'Invitation link' })).toBeNull();
  });

  test('the link selects itself when focused; a clipboard that refuses is said, the link left to copy by hand', async () => {
    const view = await openMenu(
      {
        createInvitation: () => Promise.resolve({ invitation: anInvitation('x'), token: TOKEN }),
      },
      'owner',
      refusingClipboard,
    );
    await invite(view);
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

  test('the open links are a press away: the dialog closes on the Invitations page', async () => {
    const id = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
    const view = await openMenu({
      invitations: () => Promise.resolve(page(anInvitation(id))),
    });
    const dialog = await invite(view);
    await person().click(within(dialog).getByRole('link', { name: 'See and revoke open links' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/invitations');
    expect(await view.findByRole('heading', { level: 1, name: 'Invitations' })).toBeDefined();
    await settle();
    expect(view.getByRole('button', { name: 'Revoke' })).toBeDefined();
  });
});
