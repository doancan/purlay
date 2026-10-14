/**
 * Profiles as a person meets them (#488, D-131): set from the account menu — only what was edited
 * sent, a cleared field cleared, a refusal said on its field — and read where people are: a
 * conversation's heading with the other person's local time and status, their profile beside it,
 * and the picker. Through the real screens over an API the test wrote, at the feed's fixed minute.
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
    const name = view.getByRole('button', { name: `Open ${ALICE.displayName}’s profile` });
    await person().click(name);
    await settle();
    const panel = view.getByRole('complementary', { name: /^Profile/ });
    expect(panel.textContent).toContain('Platform lead');
    expect(panel.textContent).toContain('On call');
    expect(panel.textContent).toContain('Asia/Tokyo');
    expect(panel.textContent).toContain(`${at('Asia/Tokyo')} local time`);
    expect(name.getAttribute('aria-expanded')).toBe('true');
    await expectNoAxeViolations(view.container);

    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('complementary', { name: /^Profile/ })).toBeNull();
    expectFocusOn(view.getByRole('button', { name: `Open ${ALICE.displayName}’s profile` }));
    view.unmountAll();
  });

  test('a profile with nothing in it says so', async () => {
    const view = await withAlice({ title: null, timeZone: null, status: null });
    await person().click(view.getByRole('button', { name: /profile$/ }));
    await settle();
    expect(view.getByRole('complementary', { name: /^Profile/ }).textContent).toContain(
      'Nothing here yet.',
    );
    view.unmountAll();
  });
});

type View = Awaited<ReturnType<typeof renderApp>>;

/** The whole frame — the account menu is the sidebar's — signed in with this profile. */
const openFrame = async (api: Partial<Api> = {}, profile: Profile = MINE): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi({ me: () => Promise.resolve({ ...aSession(), profile }), ...api }),
  });
  await settle();
  await person().click(view.getByRole('button', { name: 'Account: Dogancan' }));
  await person().click(await view.findByRole('menuitem', { name: 'Your profile…' }));
  await settle();
  return view;
};

const MINE: Profile = { title: 'Engineer', timeZone: 'Europe/Istanbul', status: null };

const field = (view: View, name: string): HTMLInputElement =>
  within(view.getByRole('dialog')).getByRole<HTMLInputElement>('combobox', { name });

const textbox = (view: View, name: string): HTMLInputElement =>
  within(view.getByRole('dialog')).getByRole<HTMLInputElement>('textbox', { name });

describe('your profile, from the account menu', () => {
  test('shows what is yours now, sends only what you changed, and says it is saved', async () => {
    const sent: UpdateProfileRequest[] = [];
    const view = await openFrame({
      updateProfile: (input) => {
        sent.push(input);
        return Promise.resolve({ ...MINE, title: 'Staff engineer' });
      },
    });
    const dialog = view.getByRole('dialog');
    expect(textbox(view, 'Title').value).toBe('Engineer');
    expect(field(view, 'Time zone').value).toBe('Europe/Istanbul');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await expectNoAxeViolations(dialog);

    await person().clear(textbox(view, 'Title'));
    await person().type(textbox(view, 'Title'), '  Staff engineer ');
    await person().click(save);
    await settle();

    expect(sent).toEqual([{ title: 'Staff engineer' }]);
    expect(within(dialog).getByRole('status').textContent).toBe('Saved.');
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
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Save' }));
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
      within(view.getByRole('dialog')).getByRole('button', { name: 'Use this device’s time zone' }),
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
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(field(view, 'Time zone').getAttribute('aria-invalid')).toBe('true');
    expect(within(view.getByRole('dialog')).getByRole('alert').textContent).toContain(
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
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(view.getByRole('dialog')).getByRole('alert').textContent).toMatch(
      /^Your profile was not saved\. /,
    );
    expect(textbox(view, 'Status').value).toBe('Out today');
    view.unmount();
  });
});

describe('where people are picked', () => {
  test('each says what they do and the time it is where they are', async () => {
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        members: () =>
          Promise.resolve([
            { user: ME, role: 'owner' as const, joinedAt: WHEN, profile: MINE },
            { user: ALICE, role: 'member' as const, joinedAt: WHEN, profile: TOKYO },
          ]),
      }),
    });
    await settle();
    await person().click(view.getByRole('button', { name: 'New message' }));
    await settle();
    const dialog = view.getByRole('dialog');
    const row = within(dialog).getByText('@alice', { exact: false }).closest('li');
    expect(row?.textContent).toContain('Platform lead · ');
    expect(row?.textContent).toContain('local time');
    view.unmount();
  });
});
