/**
 * Profiles as a person meets them (#488, D-131): set on the Profile page of Settings (D-146) — only
 * what was edited sent, a cleared field cleared, a refusal said on its field — and read where people
 * are: a conversation's heading with the other person's local time and status, their profile beside
 * it, and the picker. Through the real screens over an API the test wrote, at the feed's fixed minute.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Profile, UpdateProfileRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  IDS,
  ME,
  WHEN,
  aChannel,
  aSession,
  aSignedInApi,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { feedWorld } from '../../testing/feed-world';
import { FeedPortsContext } from '../channel/feed-ports';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const TOKYO: Profile = { title: 'Platform lead', timeZone: 'Asia/Tokyo', status: 'On call' };
const conversation = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });

/** A conversation with Alice, whose profile says where she is. */
const withAlice = async (profile: Profile = TOKYO): Promise<ChannelView> =>
  await mountChannel({
    channelId: IDS.dm,
    channels: [...someChannels(), conversation],
    members: [{ user: ME }, { user: ALICE, profile }],
    messages: page([]),
  });

/** The other person's name, which heads the conversation and opens their profile. */
const nameOf = (view: ChannelView): HTMLElement =>
  within(view.getByRole('heading', { level: 1 })).getByRole('button');

/** The time at the feed's minute (12:00 UTC) in a zone, as an English reader reads it. */
const at = (timeZone: string): string =>
  new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    Date.UTC(2026, 8, 9, 12, 0, 0),
  );

describe('a conversation with one other person', () => {
  test('is headed by them: the time where they are, and their status', async () => {
    const view = await withAlice();
    const header = view.container.querySelector('header');
    expect(header?.textContent).toContain(`${at('Asia/Tokyo')} local time`);
    expect(at('Asia/Tokyo')).toContain('09:00');
    expect(header?.textContent).toContain('On call');
    view.unmountAll();
  });

  test('says nothing of a time or a status they have not set', async () => {
    const view = await withAlice({ title: null, timeZone: null, status: null });
    expect(view.container.querySelector('header')?.textContent).not.toContain('local time');
    view.unmountAll();
  });

  test('their name opens their profile beside it, and Esc gives focus back to the name', async () => {
    const view = await withAlice();
    const name = nameOf(view);
    // Its name is the one it shows (WCAG 2.5.3); what it does is said beside it.
    expect(name.textContent).toBe('Alice');
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      `Open ${ALICE.displayName}’s profile`,
    );
    await person().click(name);
    await settle();
    const panel = view.getByRole('complementary', { name: /^Profile/ });
    expect(panel.textContent).toContain('Platform lead');
    expect(panel.textContent).toContain('On call');
    expect(panel.textContent).toContain('Asia/Tokyo');
    expect(panel.textContent).toContain(`${at('Asia/Tokyo')} local time`);
    expect(name.getAttribute('aria-pressed')).toBe('true');
    await expectNoAxeViolations(view.container);

    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('complementary', { name: /^Profile/ })).toBeNull();
    expectFocusOn(nameOf(view));
    view.unmountAll();
  });

  test('online, they have a dot by their name, said in words in the heading and the profile (D-136)', async () => {
    const view = await withAlice();
    const header = view.container.querySelector('header');
    const dot = (): Element | null | undefined => header?.querySelector('[data-online]');
    expect(dot()).toBeNull();
    expect(header?.textContent).not.toContain('online');
    act(() => {
      view.engine().applyPresence([{ userId: ALICE.id, online: true, version: 1 }]);
    });
    expect(dot()).not.toBeNull();
    expect(header?.textContent).toContain('online');
    await person().click(nameOf(view));
    await settle();
    const panel = view.getByRole('complementary', { name: /^Profile/ });
    expect(panel.querySelector('[data-online]')).not.toBeNull();
    expect(within(panel).getByText('Online now')).toBeDefined();
    await expectNoAxeViolations(view.container);
    act(() => {
      view.engine().applyPresence([{ userId: ALICE.id, online: false, version: 2 }]);
    });
    expect(dot()).toBeNull();
    expect(within(panel).queryByText('Online now')).toBeNull();
    view.unmountAll();
  });

  test('a zone this browser cannot format in shows no time, and the profile still names it', async () => {
    const view = await withAlice({ title: null, timeZone: 'Mars/Olympus_Mons', status: null });
    expect(view.container.querySelector('header')?.textContent).not.toContain('local time');
    await person().click(nameOf(view));
    await settle();
    const panel = view.getByRole('complementary', { name: /^Profile/ });
    expect(panel.textContent).toContain('Mars/Olympus_Mons');
    expect(panel.textContent).not.toContain('local time');
    view.unmountAll();
  });

  test('the profile says it is loading, and that it failed, with Retry', async () => {
    let refuse = true;
    let answer: () => void = () => undefined;
    const view = await mountChannel({
      channelId: IDS.dm,
      channels: [...someChannels(), conversation],
      messages: page([]),
      api: {
        members: () =>
          refuse
            ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
            : new Promise((resolve) => {
                answer = (): void => {
                  resolve([
                    { user: ME, role: 'owner', joinedAt: WHEN, profile: MINE },
                    { user: ALICE, role: 'member', joinedAt: WHEN, profile: TOKYO },
                  ]);
                };
              }),
      },
    });
    await person().click(nameOf(view));
    await settle();
    const panel = view.getByRole('complementary', { name: /^Profile/ });
    expect(within(panel).getByRole('alert').textContent).toContain('The profile did not load.');
    expect(panel.textContent).not.toContain('Nothing here yet.');

    refuse = false;
    await person().click(within(panel).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(panel).getByRole('status').textContent).toContain('Loading the profile');
    answer();
    await settle();
    expect(panel.textContent).toContain('Platform lead');
    view.unmountAll();
  });

  test('a note to yourself shows no time or status of yours beside your name', async () => {
    const view = await mountChannel({
      channelId: IDS.dm,
      channels: [...someChannels(), aChannel(IDS.dm, null, { type: 'direct_message', peer: ME })],
      members: [{ user: ME, profile: TOKYO }],
      messages: page([]),
    });
    expect(view.container.querySelector('header')?.textContent).not.toContain('local time');
    expect(view.container.querySelector('header')?.textContent).not.toContain('On call');
    view.unmountAll();
  });

  test('a profile with nothing in it says so', async () => {
    const view = await withAlice({ title: null, timeZone: null, status: null });
    await person().click(nameOf(view));
    await settle();
    expect(view.getByRole('complementary', { name: /^Profile/ }).textContent).toContain(
      'Nothing here yet.',
    );
    view.unmountAll();
  });
});

type View = Awaited<ReturnType<typeof renderApp>>;

/** The whole frame at the Profile page of Settings (D-146), signed in with this profile. */
const openFrame = async (api: Partial<Api> = {}, profile: Profile = MINE): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/profile',
    api: aSignedInApi({ me: () => Promise.resolve({ ...aSession(), profile }), ...api }),
  });
  await settle();
  await view.findByRole('heading', { level: 1, name: 'Profile' });
  return view;
};

const MINE: Profile = { title: 'Engineer', timeZone: 'Europe/Istanbul', status: null };

const field = (view: View, name: string): HTMLInputElement =>
  within(view.getByRole('main')).getByRole<HTMLInputElement>('combobox', { name });

const textbox = (view: View, name: string): HTMLInputElement =>
  within(view.getByRole('main')).getByRole<HTMLInputElement>('textbox', { name });

describe('your profile, on its page of Settings', () => {
  test('shows what is yours now, sends only what you changed, and says it is saved', async () => {
    const sent: UpdateProfileRequest[] = [];
    const view = await openFrame({
      updateProfile: (input) => {
        sent.push(input);
        return Promise.resolve({ ...MINE, title: 'Staff engineer' });
      },
    });
    const main = view.getByRole('main');
    // Who you are is GitHub's, shown and not edited.
    expect(within(main).getByText('@dogancan')).toBeDefined();
    expect(textbox(view, 'Title').value).toBe('Engineer');
    expect(field(view, 'Time zone').value).toBe('Europe/Istanbul');
    const save = within(main).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await expectNoAxeViolations(main);

    await person().clear(textbox(view, 'Title'));
    await person().type(textbox(view, 'Title'), '  Staff engineer ');
    await person().click(save);
    await settle();

    expect(sent).toEqual([{ title: 'Staff engineer' }]);
    expect(within(main).getByRole('status').textContent).toBe('Saved.');
    view.unmount();
  });

  test('left without saving, what was typed is let go', async () => {
    const view = await openFrame();
    await person().type(textbox(view, 'Status'), 'Out today');
    await person().click(view.getByRole('link', { name: 'Preferences' }));
    await view.findByRole('heading', { level: 1, name: 'Preferences' });
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    expect(textbox(view, 'Status').value).toBe('');
    view.unmount();
  });

  test('saved, the fields show what was saved at once, and focus goes back to the form', async () => {
    const view = await openFrame({
      updateProfile: () => Promise.resolve({ ...MINE, title: 'Staff engineer' }),
    });
    await person().clear(textbox(view, 'Title'));
    await person().type(textbox(view, 'Title'), 'Staff engineer{Enter}');
    await settle();
    // The server's answer, not `/api/me` read again — which here still says "Engineer".
    expect(textbox(view, 'Title').value).toBe('Staff engineer');
    expectFocusOn(textbox(view, 'Title'));
    view.unmount();
  });

  test('while a save is on its way the fields cannot change and it is not sent twice', async () => {
    let calls = 0;
    const view = await openFrame({
      updateProfile: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
    });
    await person().type(textbox(view, 'Status'), 'Out today');
    const save = within(view.getByRole('main')).getByRole('button', { name: 'Save' });
    await person().click(save);
    expect(textbox(view, 'Status').readOnly).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    await person().click(save);
    expect(calls).toBe(1);
    view.unmount();
  });

  test('every field the server refuses is marked, each with its own words', async () => {
    const view = await openFrame({
      updateProfile: () =>
        Promise.reject(
          new ApiError(400, 'VALIDATION_FAILED', 'no', { title: 'bad', timeZone: 'unknown' }),
        ),
    });
    await person().type(textbox(view, 'Status'), 'x');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(textbox(view, 'Title').getAttribute('aria-invalid')).toBe('true');
    expect(field(view, 'Time zone').getAttribute('aria-invalid')).toBe('true');
    expect(textbox(view, 'Status').getAttribute('aria-invalid')).toBeNull();
    view.unmount();
  });

  test('a field emptied is cleared', async () => {
    const sent: UpdateProfileRequest[] = [];
    const view = await openFrame({
      updateProfile: (input) => {
        sent.push(input);
        return Promise.resolve({ ...MINE, timeZone: null });
      },
    });
    await person().click(field(view, 'Time zone'));
    await person().keyboard('{Control>}a{/Control}{Backspace}');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(sent).toEqual([{ timeZone: null }]);
    view.unmount();
  });

  test('this device’s time zone is one press away', async () => {
    const sent: UpdateProfileRequest[] = [];
    const view = await openFrame(
      {
        updateProfile: (input) => {
          sent.push(input);
          return Promise.resolve(MINE);
        },
      },
      { title: null, timeZone: null, status: null },
    );
    await person().click(
      within(view.getByRole('main')).getByRole('button', { name: 'Use this device’s time zone' }),
    );
    expect(field(view, 'Time zone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    view.unmount();
  });

  test('a zone the server refuses is said on that field, and what you typed stays', async () => {
    const view = await openFrame({
      updateProfile: () =>
        Promise.reject(
          new ApiError(400, 'VALIDATION_FAILED', 'no', { timeZone: 'is not a known time zone' }),
        ),
    });
    await person().clear(field(view, 'Time zone'));
    await person().type(field(view, 'Time zone'), 'Mars/Base');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(field(view, 'Time zone').getAttribute('aria-invalid')).toBe('true');
    expect(within(view.getByRole('main')).getByRole('alert').textContent).toContain(
      'That is not a time zone we know.',
    );
    expect(field(view, 'Time zone').value).toBe('Mars/Base');
    view.unmount();
  });

  test('a failure of any other kind is said for the form, with its cause', async () => {
    const view = await openFrame({
      updateProfile: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    await person().type(textbox(view, 'Status'), 'Out today');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(view.getByRole('main')).getByRole('alert').textContent).toMatch(
      /^Your profile was not saved\. /,
    );
    expect(textbox(view, 'Status').value).toBe('Out today');
    view.unmount();
  });
});

describe('where people are picked', () => {
  test('each says what they do and the time it is where they are', async () => {
    // The feed's fixed minute, not the wall clock's: the time shown is the one asserted.
    const view = await renderApp(
      <FeedPortsContext.Provider value={feedWorld().ports}>
        <Outlet />
      </FeedPortsContext.Provider>,
      {
        path: `/w/acme/c/${IDS.api}`,
        api: aSignedInApi({
          members: () =>
            Promise.resolve([
              { user: ME, role: 'owner' as const, joinedAt: WHEN, profile: MINE },
              { user: ALICE, role: 'member' as const, joinedAt: WHEN, profile: TOKYO },
            ]),
        }),
      },
    );
    await settle();
    await person().click(view.getByRole('button', { name: 'New message' }));
    await settle();
    const dialog = view.getByRole('dialog');
    const row = within(dialog).getByText('@alice', { exact: false }).closest('li');
    expect(row?.textContent).toContain(`Platform lead · ${at('Asia/Tokyo')} local time`);
    view.unmount();
  });
});

describe('the name on Profile (D-235)', () => {
  const openAs = async (nameFromGitHub: boolean, api: Partial<Api> = {}): Promise<View> => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings/profile',
      api: aSignedInApi({
        me: () => Promise.resolve({ ...aSession(), profile: MINE, nameFromGitHub }),
        ...api,
      }),
    });
    await settle();
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    return view;
  };

  test('an account GitHub made shows its name and offers nothing to change', async () => {
    const view = await openAs(true);
    expect(within(view.getByRole('main')).queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(
      view.getByText('Your name and picture come from GitHub and change there.'),
    ).toBeDefined();
    view.unmount();
  });

  test('any other account sets it: trimmed, saved on its own, and drawn at once', async () => {
    const sent: UpdateProfileRequest[] = [];
    const view = await openAs(false, {
      updateProfile: (input) => {
        sent.push(input);
        return Promise.resolve(MINE);
      },
    });
    const name = textbox(view, 'Name');
    expect(
      within(view.getByRole('main')).getByRole('button', { name: 'Save name' }),
    ).toHaveProperty('disabled', true);
    await person().clear(name);
    await person().type(name, '  Ada Lovelace ');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save name' }));
    await settle();
    expect(sent).toEqual([{ displayName: 'Ada Lovelace' }]);
    expect(within(view.getByRole('main')).getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(within(view.getByRole('main')).getAllByText('Saved.').length).toBeGreaterThan(0);
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('a name the server refuses is said under the field; any other failure beside Save', async () => {
    let answer: ApiError = new ApiError(400, 'VALIDATION_FAILED', 'no', { displayName: 'bad' });
    const view = await openAs(false, {
      updateProfile: () => Promise.reject(answer),
    });
    const name = textbox(view, 'Name');
    await person().clear(name);
    await person().type(name, 'Ada');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save name' }));
    await settle();
    expect(view.getByText('That cannot be shown as written.')).toBeDefined();
    answer = new ApiError(500, 'INTERNAL', 'no');
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Save name' }));
    await settle();
    expect(view.getByText(/^Your profile was not saved\./)).toBeDefined();
    view.unmount();
  });
});
