/**
 * Invite people (D-115, D-146, `UX.md` §2, §8), the quick dialog from the workspace menu, through the
 * real frame: who is offered it, making a link and copying it, the link shown once, and the way to
 * the Invitations page, where the open links are seen and revoked (`settings/pages/invitations.test.tsx`).
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type {
  CreatedInvitation,
  CreateInvitationRequest,
  Invitation,
  InvitationMailResult,
  InvitationPage,
} from '@purlay/types';
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
  await person().click(view.getByRole('button', { name: /Switch workspace/ }));
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
    await person().click(view.getByRole('button', { name: /Switch workspace/ }));
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

/** A server that can send mail: the same answer the sign-in screen reads. */
const withMail: Partial<Api> = {
  authMethods: () =>
    Promise.resolve({
      github: true,
      email: true,
      oidc: null,
      signUp: 'invite-only',
      password: true,
    }),
};

const queuedFor = (...outcomes: InvitationMailResult[]): Promise<CreatedInvitation> =>
  Promise.resolve({ invitation: anInvitation('x'), token: TOKEN, mail: outcomes });

const typeInto = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  text: string,
): Promise<HTMLInputElement> => {
  const field = view.getByRole('textbox', { name: 'Email addresses' }) as HTMLInputElement;
  await person().click(field);
  await person().keyboard(text);
  return field;
};

describe('invite people by email', () => {
  test('without mail the dialog is the link alone: no address field, no mention of email', async () => {
    const view = await openMenu({});
    const dialog = await invite(view);
    expect(view.queryByRole('textbox', { name: 'Email addresses' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Make a link' })).toBeDefined();
    expect(dialog.textContent).not.toMatch(/email/i);
    expect(dialog.textContent).toContain('A link lets anyone signed in join as a member');
  });

  test('with mail there is an address field above the link, and the send waits for an address', async () => {
    const view = await openMenu(withMail);
    const dialog = await invite(view);
    expect(await view.findByRole('textbox', { name: 'Email addresses' })).toBeDefined();
    expect(dialog.textContent).toContain('Send the link by email');
    const send = within(dialog).getByRole('button', { name: 'Send invitations' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    // The link is still there to make by hand.
    expect(within(dialog).getByRole('button', { name: 'Make a link' })).toBeDefined();
    await expectNoAxeViolations(dialog);
  });

  test('Enter and a comma make chips, × and Backspace take them away, and Enter sends nothing', async () => {
    let asked = 0;
    const view = await openMenu({
      ...withMail,
      createInvitation: () => {
        asked += 1;
        return queuedFor();
      },
    });
    await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    const field = await typeInto(
      view,
      'ann@example.test{Enter}bob@example.test,carol@example.test',
    );
    await person().keyboard('{Enter}');
    expect(asked).toBe(0);
    for (const address of ['ann@example.test', 'bob@example.test', 'carol@example.test']) {
      expect(view.getByText(address)).toBeDefined();
    }
    expect(field.value).toBe('');
    await person().click(view.getByRole('button', { name: 'Remove bob@example.test' }));
    expect(view.queryByText('bob@example.test')).toBeNull();
    await person().click(field);
    await person().keyboard('{Backspace}');
    expect(view.queryByText('carol@example.test')).toBeNull();
    expect(view.getByText('ann@example.test')).toBeDefined();
    expect(view.getByRole('button', { name: 'Send invitation' })).toBeDefined();
  });

  test('an address typed again in any case is one chip; a paste of several makes several', async () => {
    const view = await openMenu(withMail);
    await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(view, 'Ann@Example.test{Enter}ann@example.TEST{Enter}');
    expect(view.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    await person().paste('bob@example.test, carol@example.test;\ndan@example.test');
    expect(view.getAllByRole('button', { name: /^Remove / })).toHaveLength(4);
  });

  test('a wrong address stays, red and in words, and is not sent; the right ones are', async () => {
    const requests: CreateInvitationRequest[] = [];
    const view = await openMenu({
      ...withMail,
      createInvitation: (_, request) => {
        if (request !== undefined) requests.push(request);
        return queuedFor({ address: 'ann@example.test', outcome: 'queued' });
      },
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(view, 'ann@example.test{Enter}nope{Enter}');
    expect(within(dialog).getByText('(not an email address)')).toBeDefined();
    await expectNoAxeViolations(dialog);
    await person().click(view.getByRole('button', { name: 'Send invitation' }));
    await settle();
    expect(requests).toEqual([{ emails: ['ann@example.test'], locale: 'en' }]);
    // The wrong one is still there to be fixed, never silently dropped.
    expect(view.getByText('nope')).toBeDefined();
    expect(view.queryByText('ann@example.test')).toBeNull();
  });

  test('says the mail server was asked — not that it was sent or arrived — and shows the link too', async () => {
    const view = await openMenu({
      ...withMail,
      createInvitation: () =>
        queuedFor(
          { address: 'ann@example.test', outcome: 'queued' },
          { address: 'bob@example.test', outcome: 'queued' },
        ),
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(view, 'ann@example.test{Enter}bob@example.test{Enter}');
    await person().click(view.getByRole('button', { name: 'Send 2 invitations' }));
    await settle();
    const status = within(dialog).getByRole('status');
    expect(status.textContent).toContain(
      'Asked the mail server to send the invitation to 2 people.',
    );
    expect(status.textContent).toContain('not confirmed that it arrived');
    expect(dialog.textContent).not.toMatch(/\b(sent to|delivered)\b/i);
    expect((view.getByRole('textbox', { name: 'Invitation link' }) as HTMLInputElement).value).toBe(
      `${window.location.origin}/invite#${TOKEN}`,
    );
    expect(view.queryByText('ann@example.test')).toBeNull();
  });

  test('a partly refused send names who, and why, and never calls it sent', async () => {
    const view = await openMenu({
      ...withMail,
      createInvitation: () =>
        queuedFor(
          { address: 'ann@example.test', outcome: 'queued' },
          { address: 'bob@example.test', outcome: 'inviter_limit' },
          { address: 'carol@example.test', outcome: 'inviter_limit' },
          { address: 'dan@example.test', outcome: 'workspace_limit' },
          { address: 'eve@example.test', outcome: 'unavailable' },
        ),
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(
      view,
      'ann@example.test,bob@example.test,carol@example.test,dan@example.test,eve@example.test,',
    );
    await person().click(view.getByRole('button', { name: 'Send 5 invitations' }));
    await settle();
    const words = within(dialog).getByRole('status').textContent;
    expect(words).toContain('Asked the mail server to send the invitation to 1 person.');
    expect(words).toContain(
      'You have reached today’s limit of 50 invitation emails, so these were not sent: bob@example.test, carol@example.test.',
    );
    expect(words).toContain(
      'This workspace has reached today’s limit of 200 invitation emails, so these were not sent: dan@example.test.',
    );
    expect(words).toContain(
      'This server cannot send email, so these were not sent: eve@example.test.',
    );
    // The refused stay in the field; the queued one is on its way.
    expect(within(dialog).getAllByRole('button', { name: /^Remove / })).toHaveLength(4);
    expect(view.getByRole('textbox', { name: 'Invitation link' })).toBeDefined();
  });

  test('when everything is refused it claims nothing was asked, and the link is there to copy', async () => {
    const view = await openMenu({
      ...withMail,
      createInvitation: () => queuedFor({ address: 'ann@example.test', outcome: 'inviter_limit' }),
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(view, 'ann@example.test{Enter}');
    await person().click(view.getByRole('button', { name: 'Send invitation' }));
    await settle();
    const words = within(dialog).getByRole('status').textContent;
    expect(words).not.toContain('Asked the mail server');
    expect(words).toContain('limit of 50 invitation emails');
    expect(view.getByRole('textbox', { name: 'Invitation link' })).toBeDefined();
  });

  test('a request that fails says so, keeps the addresses, and claims nothing', async () => {
    const view = await openMenu({
      ...withMail,
      createInvitation: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await typeInto(view, 'ann@example.test{Enter}');
    await person().click(view.getByRole('button', { name: 'Send invitation' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Could not send the invitations.',
    );
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(dialog.textContent).not.toContain('Asked the mail server');
    expect(view.getByText('ann@example.test')).toBeDefined();
  });

  test('more than twenty addresses: the rest are left out, and it says so', async () => {
    const view = await openMenu(withMail);
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await person().click(view.getByRole('textbox', { name: 'Email addresses' }));
    await person().paste(
      Array.from({ length: 22 }, (_, n) => `p${String(n)}@example.test`).join(' '),
    );
    expect(view.getAllByRole('button', { name: /^Remove / })).toHaveLength(20);
    expect(within(dialog).getByRole('alert').textContent).toContain('Up to 20 addresses at a time');
  });

  test('making the link by hand, with mail on, sends no address', async () => {
    const requests: (CreateInvitationRequest | undefined)[] = [];
    const view = await openMenu({
      ...withMail,
      createInvitation: (_, request) => {
        requests.push(request);
        return Promise.resolve({ invitation: anInvitation('x'), token: TOKEN });
      },
    });
    const dialog = await invite(view);
    await view.findByRole('textbox', { name: 'Email addresses' });
    await person().click(view.getByRole('button', { name: 'Make a link' }));
    await settle();
    expect(requests).toEqual([undefined]);
    expect(within(dialog).queryByRole('status')).toBeNull();
  });
});
