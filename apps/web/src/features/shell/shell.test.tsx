/**
 * The signed-in frame, from the address down: who, which workspace, the connection, and
 * the screens that decide where a person lands. The API is a fake the test writes; the
 * socket is one it drives.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { IDS, WHEN, aSession, aSignedInApi, aChannel } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';
import { DEFAULT_CHANNEL_NAME } from '@purlay/types';
import { PERSON_KEY } from '../../data/browser-storage';
import { page as aPage } from '../../testing/channel-harness';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const visit = async (path: string, api: Api): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, { path, api });
  await settle();
  return view;
};

const here = (view: Awaited<ReturnType<typeof renderApp>>): string =>
  view.world.history.stack.at(-1) ?? '';

describe('the session gate', () => {
  test('shows the frame, not a blank page, while it asks who is signed in', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme',
      api: anApi({ me: () => new Promise(() => undefined) }),
    });
    expect(view.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(view.queryByRole('main')).toBeNull();
  });

  test('a 401 is signed out: the browser goes to sign-in without leaving a page Back would bounce from', async () => {
    const view = await visit(
      '/w/acme',
      anApi({ me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')) }),
    );
    expect(here(view)).toBe('/sign-in');
    expect(view.world.history.stack).toEqual(['/sign-in']);
  });

  test('anything else is a failure to reach Purlay, not a sign-out, and can be retried', async () => {
    let answer: Promise<ReturnType<typeof aSession>> = Promise.reject(
      new ApiError(0, 'NETWORK', 'offline'),
    );
    const view = await visit(
      '/w/acme',
      aSignedInApi({ me: () => answer, channels: () => Promise.resolve([]) }),
    );
    expect(view.getByRole('alert').textContent).toContain("Couldn't reach Purlay");
    expect(here(view)).toBe('/w/acme');
    answer = Promise.resolve(aSession());
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('acme-eng')).toBeDefined();
  });
});

describe('the browser this page is in, when somebody else signed in here last (#694)', () => {
  /** Opens #api with the person's identity held back until the browser holds `kept`. */
  const openWith = async (kept: Record<string, string>): ReturnType<typeof renderApp> => {
    let answer: (session: ReturnType<typeof aSession>) => void = () => undefined;
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        me: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        messages: () => Promise.resolve(aPage([])),
      }),
    });
    for (const [key, value] of Object.entries(kept)) view.world.storage.setItem(key, value);
    await act(async () => {
      answer(aSession());
      await Promise.resolve();
    });
    await settle();
    return view;
  };

  test("the last person's draft is not in the composer, and is gone", async () => {
    const view = await openWith({
      [PERSON_KEY]: 'somebody-else',
      [`purlay.draft.somebody-else.${IDS.api}`]: 'words somebody else did not send',
    });
    expect(view.getByRole('textbox', { name: 'Message api' })).toHaveProperty('value', '');
    expect(
      Object.keys(view.world.storage.data).filter((key) => key.startsWith('purlay.draft.')),
    ).toEqual([]);
  });

  test('the same person signing in again finds their draft where they left it', async () => {
    const view = await openWith({
      [PERSON_KEY]: aSession().user.id,
      [`purlay.draft.${aSession().user.id}.${IDS.api}`]: 'my own words',
    });
    expect(view.getByRole('textbox', { name: 'Message api' })).toHaveProperty(
      'value',
      'my own words',
    );
  });
});

describe('a page whose person changes under it (#694)', () => {
  test('somebody else signing in in another tab gets a page of their own: no composer text, no cache', async () => {
    const me = aSession();
    const other = { ...me, user: { ...me.user, id: 'another-person', username: 'another' } };
    let who = me;
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        me: () => Promise.resolve(who),
        messages: () => Promise.resolve(aPage([])),
      }),
    });
    await settle();
    const box = (): HTMLElement => view.getByRole('textbox', { name: 'Message api' });
    await person().type(box(), 'what the first person was writing');
    // Anything the page cached for the first person.
    view.world.client.setQueryData(['what-the-first-person-saw'], 'theirs');
    // The cookie is the browser's: the next read of the person answers with whoever signed in last.
    who = other;
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: keys.me });
    });
    await settle();
    expect(box()).toHaveProperty('value', '');
    expect(view.world.client.getQueryData<string>(['what-the-first-person-saw'])).toBeUndefined();
    expect(view.world.storage.getItem(PERSON_KEY)).toBe('another-person');
    expect(
      Object.keys(view.world.storage.data).filter((key) => key.startsWith('purlay.draft.')),
    ).toEqual([]);
  });
});

describe('the session read again', () => {
  test('a failure while the page already holds the person keeps the page: it is not torn down', async () => {
    let fail = false;
    const view = await visit(
      `/w/acme/c/${IDS.api}`,
      aSignedInApi({
        me: () =>
          fail
            ? Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'busy'))
            : Promise.resolve(aSession()),
      }),
    );
    expect(view.getByRole('heading', { level: 1, name: 'api' })).toBeDefined();
    fail = true;
    await act(async () => {
      await view.world.client.refetchQueries({ queryKey: keys.me });
    });
    await settle();
    expect(view.queryByText("Couldn't reach Purlay")).toBeNull();
    expect(view.getByRole('heading', { level: 1, name: 'api' })).toBeDefined();
  });
});

describe('the workspace in the address', () => {
  test("is found among the person's own memberships", async () => {
    const view = await visit(`/w/acme/c/${IDS.api}`, aSignedInApi());
    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeDefined();
    expect(view.getByRole('heading', { level: 1, name: 'api' })).toBeDefined();
  });

  test('one they are not in is the same not found as one that does not exist', async () => {
    const view = await visit('/w/other', aSignedInApi());
    expect(view.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeDefined();
  });
});

describe('the frame', () => {
  test('is flat: the rail, the sidebar and the main column side by side, told apart by tone (D-110)', async () => {
    const view = await visit(`/w/acme/c/${IDS.api}`, aSignedInApi());
    const rail = view.getByRole('navigation', { name: 'Places' });
    const side = view.getByRole('complementary', { name: 'Workspace' });
    const main = view.getByRole('main');
    const frame = side.parentElement;
    expect(rail.parentElement).toBe(frame);
    expect(main.parentElement?.parentElement).toBe(frame);
    expect(frame?.className).toContain('bg-surface-100');
    for (const region of [rail, side, frame]) {
      expect(region?.className).not.toContain('shadow-card');
      expect(region?.className).not.toContain('bg-canvas');
    }
    // Navigation has grounds of its own and follows the page's theme — a light neutral in the light
    // one, the dark navy in the dark (D-180) — so it forces none; one hairline divides it from the
    // conversation.
    expect(rail.className).toContain('bg-nav-rail');
    expect(side.className).toContain('bg-nav-surface');
    for (const region of [rail, side]) expect(region.getAttribute('data-theme')).toBeNull();
    expect(side.className).toContain('border-r-hairline');
    expect(view.getAllByRole('main')).toHaveLength(1);
  });
});

describe('the front door', () => {
  test('a person with a workspace is sent to it, and from it to a channel they are in', async () => {
    const view = await visit('/', aSignedInApi());
    expect(here(view)).toBe(`/w/acme/c/${IDS.api}`);
    expect(view.world.history.stack).toHaveLength(1);
  });

  test('a workspace where they have joined nothing says to pick, or create, one', async () => {
    const view = await visit(
      '/w/acme',
      aSignedInApi({
        channels: () => Promise.resolve([aChannel(IDS.browse, 'browse', { state: null })]),
      }),
    );
    expect(view.getByRole('heading', { level: 1, name: 'Pick a channel' })).toBeDefined();
    expect(here(view)).toBe('/w/acme');
  });

  test('while the channels load there is a loading state, not a flash of the empty one', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme',
      api: aSignedInApi({ channels: () => new Promise(() => undefined) }),
    });
    await settle();
    expect(view.getAllByRole('status').some((node) => node.textContent === 'Loading')).toBe(true);
    expect(view.queryByRole('heading', { name: 'Pick a channel' })).toBeNull();
  });

  test('a channel that is not in the list is said not to be here', async () => {
    const view = await visit('/w/acme/c/00000000-0000-4000-8000-0000000000ff', aSignedInApi());
    expect(view.getByRole('heading', { level: 1, name: 'That channel is not here' })).toBeDefined();
  });

  test('while the list loads the channel screen waits', async () => {
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({ channels: () => new Promise(() => undefined) }),
    });
    await settle();
    expect(view.getAllByRole('status').some((node) => node.textContent === 'Loading')).toBe(true);
  });

  test('the open questions have their screen', async () => {
    const view = await visit('/w/acme/questions', aSignedInApi());
    expect(view.getByRole('heading', { level: 1, name: 'Open questions' })).toBeDefined();
  });
});

describe('a person with no workspace', () => {
  const none = (extra: Partial<Api> = {}): Api =>
    anApi({ me: () => Promise.resolve({ ...aSession(), memberships: [] }), ...extra });

  test('is told why, and can make one: the address is suggested from the name', async () => {
    const created: unknown[] = [];
    const view = await visit(
      '/',
      none({
        createWorkspace: (input) => {
          created.push(input);
          return Promise.resolve({
            id: IDS.workspace,
            name: input.name,
            slug: input.slug,
            avatarUrl: null,
          });
        },
      }),
    );
    expect(
      view.getByRole('heading', { level: 1, name: 'You are not in a workspace yet' }),
    ).toBeDefined();
    const user = person();
    await user.type(view.getByLabelText('Name'), 'Acme Engineering!');
    expect((view.getByLabelText('Address') as HTMLInputElement).value).toBe('acme-engineering');
    await user.click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(created).toEqual([{ name: 'Acme Engineering!', slug: 'acme-engineering' }]);
  });

  test('made, they are in the channel it starts with — not on an empty workspace, not picking channels (D-174)', async () => {
    const made = { id: IDS.workspace, name: 'Acme', slug: 'acme-new', avatarUrl: null };
    let exists = false;
    const asked: string[] = [];
    const view = await visit(
      '/',
      aSignedInApi({
        me: () =>
          Promise.resolve({
            ...aSession(),
            memberships: exists
              ? [{ workspace: made, role: 'owner' as const, joinedAt: WHEN, deepWorkUntil: null }]
              : [],
          }),
        createWorkspace: () => {
          exists = true;
          return Promise.resolve(made);
        },
        channels: (workspaceId) => {
          asked.push(workspaceId);
          return Promise.resolve([aChannel(IDS.api, DEFAULT_CHANNEL_NAME)]);
        },
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
      }),
    );
    const user = person();
    await user.type(view.getByLabelText('Name'), 'Acme');
    await user.clear(view.getByLabelText('Address'));
    await user.type(view.getByLabelText('Address'), 'acme-new');
    await user.click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();

    expect(asked).toContain(IDS.workspace);
    expect(here(view)).toBe(`/w/acme-new/c/${IDS.api}`);
    expect(view.queryByRole('heading', { name: 'Pick a channel' })).toBeNull();
    expect(view.queryByRole('heading', { name: /^Welcome to/ })).toBeNull();
    // `/` only ever redirects: Back does not return to the form.
    expect(view.world.history.stack).not.toContain('/');
  });

  test('one this server would not let make a workspace is told to ask for an invitation, with no form (D-155)', async () => {
    const view = await visit(
      '/',
      anApi({
        me: () => Promise.resolve({ ...aSession(), memberships: [], mayCreateWorkspace: false }),
      }),
    );
    expect(view.getByRole('heading', { level: 1, name: 'Ask for an invitation' })).toBeDefined();
    expect(view.queryByLabelText('Name')).toBeNull();
    expect(view.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  });

  test('an address they typed themselves is the one that is sent, and a bad one is refused before the server hears', async () => {
    const view = await visit('/', none());
    const user = person();
    await user.type(view.getByLabelText('Name'), 'Acme');
    await user.clear(view.getByLabelText('Address'));
    await user.type(view.getByLabelText('Address'), 'Not Valid');
    await user.click(view.getByRole('button', { name: 'Create workspace' }));
    expect(view.getByRole('alert').textContent).toContain('Use lowercase letters');
  });

  test.each([
    [
      'an address that is taken',
      new ApiError(409, 'WORKSPACE_SLUG_TAKEN', 'taken'),
      'That address is taken',
    ],
    [
      'one the server refuses',
      new ApiError(400, 'VALIDATION_FAILED', 'bad'),
      'Use lowercase letters',
    ],
    [
      'a name the server refuses — one nobody can see — under the name, not the address',
      new ApiError(400, 'VALIDATION_FAILED', 'bad', { name: 'not a name' }),
      'Use a name people can see',
    ],
    [
      'a refusal of who they are — the first workspace made a moment ago (D-155)',
      new ApiError(403, 'FORBIDDEN', 'no'),
      'Ask someone in your team for an invitation',
    ],
    [
      'a failure it cannot explain',
      new ApiError(500, 'INTERNAL', 'broke'),
      'The workspace was not created',
    ],
  ])('%s is said in words, and the form stays', async (_why, failure, words) => {
    const view = await visit('/', none({ createWorkspace: () => Promise.reject(failure) }));
    const user = person();
    await user.type(view.getByLabelText('Name'), 'Acme');
    await user.click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain(words);
    expect(view.getByLabelText('Name')).toBeDefined();
  });
});

describe('the connection', () => {
  test('opens when the frame does, and subscribes to the channels the person is in and no others', async () => {
    const view = await visit(`/w/acme/c/${IDS.api}`, aSignedInApi());
    view.world.sockets.open();
    await settle();
    act(() => {
      view.world.timers.advance(2_000);
    });
    const watched = view.world.sockets
      .sent('SUBSCRIBE')
      .flatMap((f) => (f.payload['channels'] as { channelId: string }[]).map((c) => c.channelId));
    expect(watched.sort()).toEqual([IDS.api, IDS.deploys, IDS.incidents].sort());
  });

  test('a subscription the server refuses is said in the bar, and Retry asks for those channels again', async () => {
    const view = await visit(`/w/acme/c/${IDS.api}`, aSignedInApi());
    view.world.sockets.open();
    await settle();
    act(() => {
      view.world.timers.advance(2_000);
    });
    const asked = view.world.sockets.sent('SUBSCRIBE');
    const first = asked[0];
    if (first === undefined) throw new Error('nothing was subscribed');
    expect(view.queryByText(/Live updates are paused/)).toBeNull();
    act(() => {
      view.world.sockets.deliver({
        event: 'ERROR',
        data: { code: 'INTERNAL', message: 'x' },
        refId: first.id,
        ts: 1,
      });
    });
    const bar = view.getByText('Live updates are paused for 3 channels').closest('[role="status"]');
    if (bar === null) throw new Error('the bar was not there');
    await person().click(within(bar as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(view.queryByText(/Live updates are paused/)).toBeNull();
  });

  test('the end of the session sends the person back to sign in', async () => {
    let signedIn = true;
    const api = aSignedInApi({
      me: () =>
        signedIn
          ? Promise.resolve(aSession())
          : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
    });
    const view = await visit(`/w/acme/c/${IDS.api}`, api);
    view.world.sockets.open();
    signedIn = false;
    await act(async () => {
      view.world.sockets.deliver({ event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 1 });
      await Promise.resolve();
    });
    await settle();
    // Said, not only done: a session the page held has ended (#693). A first visit with none is the
    // plain sign-in, in the session gate's own test.
    expect(here(view)).toBe('/sign-in?reason=ended');
    expect(view.getByText(/Your session ended/)).toBeDefined();
  });
});

describe('the sign-in screen', () => {
  const out = (): Api =>
    anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      authMethods: () =>
        Promise.resolve({ github: true, email: false, oidc: null, signUp: 'invite-only' }),
    });

  test('without mail, is a button to GitHub, which is a real navigation, above the password form', async () => {
    const view = await visit('/sign-in', out());
    expect(view.getByRole('link', { name: 'Continue with GitHub' }).getAttribute('href')).toBe(
      '/auth/github',
    );
    expect(view.queryByRole('button', { name: /sign-in link/ })).toBeNull();
  });

  test('says what Purlay is in Turkish as a Turkish reader says it: the question stays open', async () => {
    const view = await renderApp(<Outlet />, { path: '/sign-in', api: out(), locale: 'tr' });
    await settle();
    expect(view.getByRole('heading', { level: 1, name: 'Purlay’e giriş yap' })).toBeDefined();
    expect(
      view.getByText('Bir sorunun, biri kapatana kadar açık kaldığı ekip sohbeti.'),
    ).toBeDefined();
  });

  test('says nothing when nothing went wrong', async () => {
    const view = await visit('/sign-in', out());
    expect(within(view.getByRole('main')).queryByRole('status')).toBeNull();
  });

  test('is a card on the navigation tone, with the product mark above the title and the button the width of the card', async () => {
    const view = await visit('/sign-in', out());
    const main = view.getByRole('main');
    expect(main.className).toContain('bg-surface-000');
    const card = view
      .getByRole('heading', { level: 1, name: 'Sign in to Purlay' })
      .closest('section');
    expect(card?.className).toContain('rounded-2xl');
    expect(card?.className).toContain('shadow-card');
    const mark = card?.querySelector('[aria-hidden="true"]');
    expect(mark?.textContent).toBe('P');
    expect(view.getByRole('link', { name: 'Continue with GitHub' }).className).toContain('w-full');
  });

  test('says nothing when there is nothing to say', async () => {
    const view = await visit('/sign-in', out());
    expect(view.queryByText('Your session ended')).toBeNull();
  });

  test('a person who is already signed in is not left looking at it', async () => {
    const view = await visit('/sign-in', aSignedInApi());
    expect(here(view)).toBe(`/w/acme/c/${IDS.api}`);
  });
});
