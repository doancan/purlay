/**
 * Invitations (D-115, D-146), through the real frame at the page's address: who is offered it, making
 * a link and copying it, the open links and revoking one, and each state of the list.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type {
  CreatedInvitation,
  CreateInvitationRequest,
  Invitation,
  InvitationPage as Page,
  UserRole,
} from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import type { Locale } from '../../../i18n/types';
import { keys } from '../../../data/keys';
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

const render = async (
  path: string,
  api: Partial<Api>,
  role: UserRole = 'owner',
  locale: Locale = 'en',
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path,
      locale,
      api: aSignedInApi({
        invitationRecipients: () => Promise.resolve({ data: [], nextCursor: null }),
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

const mailMethods: Awaited<ReturnType<Api['authMethods']>> = {
  github: false,
  email: true,
  oidc: null,
  google: false,
  signUp: 'invite-only',
  password: true,
};
const withMail: Partial<Api> = { authMethods: () => Promise.resolve(mailMethods) };

describe('invitation management regressions', () => {
  test('sends email from Settings, keeps refused addresses, shows the fallback link and refreshes the list', async () => {
    const requests: CreateInvitationRequest[] = [];
    const view = await openPage({
      ...withMail,
      invitations: () =>
        Promise.resolve(requests.length === 0 ? page() : page(anInvitation(FIRST))),
      createInvitation: (_workspaceId, request) => {
        if (request !== undefined) requests.push(request);
        return Promise.resolve({
          invitation: anInvitation(FIRST),
          token: TOKEN,
          mail: [
            { address: 'ann@example.test', outcome: 'queued' },
            { address: 'bob@example.test', outcome: 'inviter_limit' },
          ],
        });
      },
    });
    await expectNoAxeViolations(view.getByRole('main'));
    const field = main(view).getByRole('textbox', { name: 'Email addresses' });
    await person().type(field, 'ann@example.test,bob@example.test,');
    await person().click(main(view).getByRole('button', { name: 'Send 2 invitations' }));
    await settle();
    expect(requests).toEqual([{ emails: ['ann@example.test', 'bob@example.test'], locale: 'en' }]);
    expect(
      main(view).getByText('Asked the mail server to send the invitation to 1 person.'),
    ).toBeDefined();
    expect(main(view).getByText(/limit of 50 invitation emails/)).toBeDefined();
    expect(main(view).getByRole('button', { name: 'Remove bob@example.test' })).toBeDefined();
    expect(main(view).queryByRole('button', { name: 'Remove ann@example.test' })).toBeNull();
    expect(
      main(view).getByRole<HTMLInputElement>('textbox', { name: 'Invitation link' }).value,
    ).toContain(TOKEN);
    expect(main(view).getByRole('button', { name: 'Revoke' })).toBeDefined();
  });

  test('mail capability loading and failure are explicit, and retry recovers without blocking link creation', async () => {
    let finish: ((value: Awaited<ReturnType<Api['authMethods']>>) => void) | undefined;
    let reads = 0;
    const pending = new Promise<Awaited<ReturnType<Api['authMethods']>>>((resolve) => {
      finish = resolve;
    });
    const view = await openPage({
      invitations: () => Promise.resolve(page()),
      authMethods: () => {
        reads += 1;
        return reads === 1 ? pending : Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'));
      },
    });
    expect(main(view).getByText('Checking email availability…')).toBeDefined();
    expect(main(view).getByRole('button', { name: 'Make a link' })).toBeDefined();
    finish?.({
      github: false,
      email: false,
      oidc: null,
      google: false,
      signUp: 'invite-only',
      password: true,
    });
    await settle();
    expect(
      main(view).getByText(
        'Email invitations are unavailable on this server. Share a link instead.',
      ),
    ).toBeDefined();
    // Exercise an initial failure in its own mounted page rather than relying on a private cache key.
    view.unmount();
    let failed = true;
    const retryView = await openPage({
      invitations: () => Promise.resolve(page()),
      authMethods: () =>
        failed
          ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
          : Promise.resolve(mailMethods),
    });
    expect(main(retryView).getByText('Could not check email availability.')).toBeDefined();
    failed = false;
    await person().click(main(retryView).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(main(retryView).getByRole('textbox', { name: 'Email addresses' })).toBeDefined();
  });

  test('loads older invitations by cursor, preserves current rows on failure and retries the older page', async () => {
    const cursors: (string | undefined)[] = [];
    let failed = true;
    const view = await openPage({
      invitations: (_id, before) => {
        cursors.push(before);
        if (before === undefined)
          return Promise.resolve({ data: [anInvitation(SECOND)], nextCursor: SECOND });
        if (failed) return Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'));
        return Promise.resolve(page({ ...anInvitation(FIRST), createdBy: null }));
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Load older links' }));
    await settle();
    expect(main(view).getByText('Older links did not load.')).toBeDefined();
    expect(main(view).getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    failed = false;
    await person().click(main(view).getByRole('button', { name: 'Load older links' }));
    await settle();
    expect(cursors).toEqual([undefined, SECOND, SECOND]);
    expect(main(view).getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
    expect(main(view).queryByRole('button', { name: 'Load older links' })).toBeNull();
  });

  test('revoking the link just made removes it from the copy field and restores link creation', async () => {
    let made = false;
    let revoked = false;
    const view = await openPage({
      invitations: () => Promise.resolve(made && !revoked ? page(anInvitation(FIRST)) : page()),
      createInvitation: () => {
        made = true;
        return Promise.resolve({ invitation: anInvitation(FIRST), token: TOKEN });
      },
      revokeInvitation: () => {
        revoked = true;
        return Promise.resolve();
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Make a link' }));
    await settle();
    await person().click(main(view).getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(main(view).getByText('No links are open.')).toBeDefined();
    expect(main(view).queryByRole('textbox', { name: 'Invitation link' })).toBeNull();
    expect(main(view).getByRole('button', { name: 'Make a link' })).toBeDefined();
  });

  test('a pending revocation disables only its row, refuses a second click, then recovers after failure', async () => {
    let calls = 0;
    let fail: ((reason: unknown) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const view = await openPage({
      invitations: () => Promise.resolve(page(anInvitation(FIRST), anInvitation(SECOND))),
      revokeInvitation: () => {
        calls += 1;
        return pending;
      },
    });
    const [first, second] = main(view).getAllByRole<HTMLButtonElement>('button', {
      name: 'Revoke',
    });
    expect(first).toBeDefined();
    if (first === undefined) return;
    await person().click(first);
    expect(first.disabled).toBe(true);
    expect(first.getAttribute('aria-busy')).toBe('true');
    expect(second?.disabled).toBe(false);
    await person().click(first);
    expect(calls).toBe(1);
    fail?.(new ApiError(0, 'NETWORK', 'down'));
    await settle();
    expect(first.disabled).toBe(false);
    expect(view.getByText(/Could not revoke the link/)).toBeDefined();
  });

  test('makes another link without leaving the page and keeps it when a different link is revoked', async () => {
    let made = 0;
    const view = await openPage({
      invitations: () => Promise.resolve(page(anInvitation(FIRST), anInvitation(SECOND))),
      createInvitation: () => {
        made += 1;
        return Promise.resolve({
          invitation: anInvitation(made === 1 ? FIRST : SECOND),
          token: made === 1 ? TOKEN : 'f'.repeat(64),
        });
      },
      revokeInvitation: () => Promise.resolve(),
    });
    await person().click(main(view).getByRole('button', { name: 'Make a link' }));
    await settle();
    await person().click(main(view).getByRole('button', { name: 'Make another link' }));
    await settle();
    expect(
      main(view).getByRole<HTMLInputElement>('textbox', { name: 'Invitation link' }).value,
    ).toContain('f'.repeat(64));
    const first = main(view).getAllByRole('button', { name: 'Revoke' })[0];
    if (first === undefined) throw new Error('the first invitation is missing');
    await person().click(first);
    await settle();
    expect(
      main(view).getByRole<HTMLInputElement>('textbox', { name: 'Invitation link' }).value,
    ).toContain('f'.repeat(64));
    expect(
      main(view).getByText('Previous links stay open until they expire or you revoke them.'),
    ).toBeDefined();
  });
});

describe('invitation write and refresh failures', () => {
  test('a successful revocation stays removed if refreshing the list fails, and Retry recovers', async () => {
    let revoked = false;
    let readsFail = false;
    const view = await openPage({
      invitations: () =>
        readsFail
          ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
          : Promise.resolve(revoked ? page() : page(anInvitation(FIRST))),
      revokeInvitation: () => {
        revoked = true;
        readsFail = true;
        return Promise.resolve();
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Revoke' }));
    await settle();
    expect(main(view).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(
      main(view).getByText('Could not refresh the open links. Showing the last loaded list.'),
    ).toBeDefined();
    expect(view.queryByText(/Could not revoke the link/)).toBeNull();
    readsFail = false;
    await person().click(main(view).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(main(view).queryByRole('alert')).toBeNull();
  });

  test('a failed email request preserves addresses and permits retry without making a false success claim', async () => {
    let fail = true;
    const view = await openPage({
      ...withMail,
      invitations: () => Promise.resolve(page()),
      createInvitation: () =>
        fail
          ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
          : Promise.resolve({
              invitation: anInvitation(FIRST),
              token: TOKEN,
              mail: [{ address: 'ann@example.test', outcome: 'queued' }],
            }),
    });
    await person().type(
      main(view).getByRole('textbox', { name: 'Email addresses' }),
      'ann@example.test,',
    );
    await person().click(main(view).getByRole('button', { name: 'Send invitation' }));
    await settle();
    expect(main(view).getByRole('alert').textContent).toContain('Could not send the invitations.');
    expect(main(view).getByRole('button', { name: 'Remove ann@example.test' })).toBeDefined();
    expect(main(view).queryByText(/Asked the mail server/)).toBeNull();
    fail = false;
    await person().click(main(view).getByRole('button', { name: 'Send invitation' }));
    await settle();
    expect(main(view).queryByRole('alert')).toBeNull();
    expect(
      main(view).getByText('Asked the mail server to send the invitation to 1 person.'),
    ).toBeDefined();
  });
});

test('a failed mail capability refresh preserves typed invitees and Retry restores the capability', async () => {
  let failed = false;
  const view = await openPage({
    invitations: () => Promise.resolve(page()),
    authMethods: () =>
      failed
        ? Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no'))
        : Promise.resolve(mailMethods),
  });
  await person().type(
    main(view).getByRole('textbox', { name: 'Email addresses' }),
    'ann@example.test,',
  );
  failed = true;
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: keys.authMethods });
  });
  await settle();
  expect(main(view).getByText('Could not check email availability.')).toBeDefined();
  expect(main(view).getByRole('button', { name: 'Remove ann@example.test' })).toBeDefined();
  failed = false;
  await person().click(main(view).getByRole('button', { name: 'Retry' }));
  await settle();
  expect(main(view).queryByRole('alert')).toBeNull();
  expect(main(view).getByRole('button', { name: 'Remove ann@example.test' })).toBeDefined();
});

test('sends a Turkish invitation in the interface language from the localized Settings form', async () => {
  const requests: CreateInvitationRequest[] = [];
  const view = await render(
    '/w/acme/settings/invitations',
    {
      ...withMail,
      invitations: () => Promise.resolve(page()),
      createInvitation: (_id, request) => {
        if (request !== undefined) requests.push(request);
        return Promise.resolve({
          invitation: anInvitation(FIRST),
          token: TOKEN,
          mail: [{ address: 'ayse@example.test', outcome: 'queued' }],
        });
      },
    },
    'owner',
    'tr',
  );
  await view.findByRole('heading', { level: 1, name: 'Davetler' });
  await settle();
  await person().type(
    main(view).getByRole('textbox', { name: 'E-posta adresleri' }),
    'ayse@example.test,',
  );
  await person().click(main(view).getByRole('button', { name: '1 daveti gönder' }));
  await settle();
  expect(requests).toEqual([{ emails: ['ayse@example.test'], locale: 'tr' }]);
  expect(
    main(view).getByText('Posta sunucusundan daveti 1 kişiye göndermesi istendi.'),
  ).toBeDefined();
  expect(main(view).getByRole('textbox', { name: 'Davet bağlantısı' })).toBeDefined();
});
