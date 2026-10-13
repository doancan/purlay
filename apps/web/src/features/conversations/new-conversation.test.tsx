/**
 * Group conversations in the client (D-127), as a person meets them: a Conversations section in
 * the sidebar, New message — people picked, named in "To:", Start conversation — and the group's
 * title, in the header and the tab, being its people.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { Outlet } from '../../app/outlet';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  aChannel,
  aSignedInApi,
  aUser,
  someChannels,
  NO_PROFILE,
} from '../../testing/fixtures';
import { CONVERSATION_PEOPLE_MAX } from '@purlay/types';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { groups } from '../sidebar/ordering';

installDom();

const GROUP = '00000000-0000-4000-8000-0000000000c9';

const aGroup = (): ReturnType<typeof aChannel> =>
  aChannel(GROUP, null, {
    type: 'direct_message',
    peers: [ALICE, BOB],
    lastMessageAt: '2026-09-09T11:00:00.000Z',
  });

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Partial<Api> = {}, channels = someChannels()): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    api: aSignedInApi({ channels: () => Promise.resolve(channels), ...api }),
  });
  await settle();
  return view;
};

const startNew = async (view: View): Promise<void> => {
  await person().click(view.getByRole('button', { name: 'New message' }));
  await settle();
};

describe('the sidebar’s conversations', () => {
  test('lists a group by its people, and says what the section is for when there is none', async () => {
    const empty = await open();
    expect(empty.getByText('Talk to a few people at once, without a channel.')).toBeDefined();
    empty.unmount();
    const view = await open({}, [...someChannels(), aGroup()]);
    const row = view.getByRole('link', { name: `${ALICE.displayName}, ${BOB.displayName}` });
    expect(row.getAttribute('href')).toBe(`/w/acme/c/${GROUP}`);
    view.unmount();
  });

  test('a group is not a person: it is not listed under People', () => {
    expect(groups([...someChannels(), aGroup()]).map((c) => c.id)).toEqual([GROUP]);
    const pair = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });
    expect(groups([pair])).toEqual([]);
  });
});

describe('New message', () => {
  test('picks people, names them in To:, and starts the conversation of exactly them', async () => {
    const asked: (readonly string[])[] = [];
    const view = await open({
      openConversation: (_workspace, userIds) => {
        asked.push(userIds);
        return Promise.resolve(aGroup());
      },
    });
    await startNew(view);
    const dialog = view.getByRole('dialog');
    expect(dialog.textContent).toContain('To: nobody yet');
    expect(view.getByRole('button', { name: 'Start conversation' }).hasAttribute('disabled')).toBe(
      true,
    );
    // The person themselves is not offered.
    expect(view.queryByRole('button', { name: `Pick ${ME.displayName}` })).toBeNull();
    await person().click(view.getByRole('button', { name: `Pick ${ALICE.displayName}` }));
    await person().click(view.getByRole('button', { name: `Pick ${BOB.displayName}` }));
    expect(dialog.textContent).toContain(`To: ${ALICE.displayName}, ${BOB.displayName}`);
    await expectNoAxeViolations(dialog);
    await person().click(view.getByRole('button', { name: 'Start conversation' }));
    await settle();
    expect(asked).toEqual([[ALICE.id, BOB.id]]);
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${GROUP}`);
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });

  test(`holds ${String(CONVERSATION_PEOPLE_MAX - 1)} people besides you, and says a channel holds more`, async () => {
    const crowd = Array.from({ length: CONVERSATION_PEOPLE_MAX + 1 }, (_, n) =>
      aUser(
        `person${String(n).padStart(2, '0')}`,
        `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
      ),
    );
    const view = await open({
      members: () =>
        Promise.resolve(
          [ME, ...crowd].map((user) => ({
            user,
            role: 'member' as const,
            joinedAt: '2026-09-09T12:00:00.000Z',
            profile: NO_PROFILE,
          })),
        ),
    });
    await startNew(view);
    for (const one of crowd.slice(0, CONVERSATION_PEOPLE_MAX - 1)) {
      await person().click(view.getByRole('button', { name: `Pick ${one.displayName}` }));
    }
    expect(
      view.getByText('That is as many as a conversation holds; a channel holds more.'),
    ).toBeDefined();
    const next = crowd[CONVERSATION_PEOPLE_MAX - 1]?.displayName ?? '';
    expect(view.getByRole('button', { name: `Pick ${next}` }).hasAttribute('disabled')).toBe(true);
    // One picked can still be unpicked.
    const first = crowd[0]?.displayName ?? '';
    expect(view.getByRole('button', { name: `Picked ${first}` }).hasAttribute('disabled')).toBe(
      false,
    );
    view.unmount();
  });

  test('narrows the people as you type, by name or handle', async () => {
    const view = await open();
    await startNew(view);
    await person().type(view.getByLabelText('Find a person'), 'bo');
    expect(view.queryByRole('button', { name: `Pick ${ALICE.displayName}` })).toBeNull();
    expect(view.getByRole('button', { name: `Pick ${BOB.displayName}` })).toBeDefined();
    await person().type(view.getByLabelText('Find a person'), 'zzz');
    expect(view.getByText('Nobody by that name.')).toBeDefined();
    view.unmount();
  });

  test('a person picked twice is unpicked', async () => {
    const view = await open();
    await startNew(view);
    const pick = view.getByRole('button', { name: `Pick ${ALICE.displayName}` });
    await person().click(pick);
    const picked = view.getByRole('button', { name: `Picked ${ALICE.displayName}` });
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    await person().click(picked);
    expect(view.getByRole('dialog').textContent).toContain('To: nobody yet');
    view.unmount();
  });

  test('refused by the server, it says why and keeps what was picked', async () => {
    const view = await open({
      openConversation: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    await startNew(view);
    await person().click(view.getByRole('button', { name: `Pick ${ALICE.displayName}` }));
    await person().click(view.getByRole('button', { name: 'Start conversation' }));
    await settle();
    expect(view.getByRole('alert').textContent).toMatch(/^The conversation could not be started\./);
    expect(view.getByRole('dialog').textContent).toContain(`To: ${ALICE.displayName}`);
    view.unmount();
  });

  test('when the people cannot be loaded, it says so and offers to try again', async () => {
    let fail = true;
    const members = aSignedInApi().members;
    const view = await open({
      members: (workspaceId, signal) =>
        fail ? Promise.reject(new ApiError(0, 'NETWORK', 'offline')) : members(workspaceId, signal),
    });
    await startNew(view);
    expect(view.getByRole('alert').textContent).toMatch(/could not be loaded/);
    fail = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByRole('button', { name: `Pick ${ALICE.displayName}` })).toBeDefined();
    view.unmount();
  });

  test('is reached and used from the keyboard', async () => {
    const asked: (readonly string[])[] = [];
    const view = await open({
      openConversation: (_workspace, userIds) => {
        asked.push(userIds);
        return Promise.resolve(aGroup());
      },
    });
    view.getByRole('button', { name: 'New message' }).focus();
    await person().keyboard('{Enter}');
    await settle();
    view.getByRole('button', { name: `Pick ${BOB.displayName}` }).focus();
    await person().keyboard('{Enter}');
    view.getByRole('button', { name: 'Start conversation' }).focus();
    await person().keyboard('{Enter}');
    await settle();
    expect(asked).toEqual([[BOB.id]]);
    view.unmount();
  });
});

describe('a group’s title', () => {
  test('is its people, in the header and in the tab', async () => {
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${GROUP}`,
      api: aSignedInApi({
        channels: () => Promise.resolve([...someChannels(), aGroup()]),
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
      }),
    });
    await settle();
    const names = `${ALICE.displayName}, ${BOB.displayName}`;
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(names);
    expect(document.title.startsWith(names)).toBe(true);
    view.unmount();
  });
});

describe('a group’s details', () => {
  const visitGroup = async (api: Partial<Api> = {}): Promise<View> => {
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${GROUP}`,
      api: aSignedInApi({
        channels: () => Promise.resolve([...someChannels(), aGroup()]),
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
        ...api,
      }),
    });
    await settle();
    return view;
  };

  test('open from its title, and list its people, the person themselves first', async () => {
    const view = await visitGroup();
    const names = `${ALICE.displayName}, ${BOB.displayName}`;
    await person().click(view.getByRole('button', { name: names }));
    const dialog = view.getByRole('dialog');
    const people = Array.from(dialog.querySelectorAll('li')).map((row) => row.textContent);
    expect(people).toEqual([
      expect.stringContaining(ME.displayName) as unknown as string,
      expect.stringContaining(ALICE.displayName) as unknown as string,
      expect.stringContaining(BOB.displayName) as unknown as string,
    ]);
    expect(dialog.textContent).toContain('A conversation’s people never change.');
    await expectNoAxeViolations(dialog);
    view.unmount();
  });

  test('start a new conversation from its people, already picked', async () => {
    const asked: (readonly string[])[] = [];
    const view = await visitGroup({
      openConversation: (_workspace, userIds) => {
        asked.push(userIds);
        return Promise.resolve(aGroup());
      },
    });
    await person().click(
      view.getByRole('button', { name: `${ALICE.displayName}, ${BOB.displayName}` }),
    );
    await person().click(view.getByRole('button', { name: 'New conversation with these people…' }));
    await settle();
    const picker = view.getByRole('dialog');
    expect(picker.textContent).toContain(`To: ${ALICE.displayName}, ${BOB.displayName}`);
    await person().click(view.getByRole('button', { name: 'Start conversation' }));
    await settle();
    expect(asked).toEqual([[ALICE.id, BOB.id]]);
    view.unmount();
  });

  test('a conversation of two has none: its title is not a button', async () => {
    const pair = aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE });
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.dm}`,
      api: aSignedInApi({
        channels: () => Promise.resolve([...someChannels(), pair]),
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
      }),
    });
    await settle();
    const heading = view.getByRole('heading', { level: 1 });
    expect(heading.querySelector('button')).toBeNull();
    view.unmount();
  });
});
