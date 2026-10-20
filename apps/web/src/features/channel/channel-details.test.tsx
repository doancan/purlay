/**
 * A channel's details, opened from its name in the header (D-123): its tabs and how a keyboard moves
 * between them (D-154), the name and topic, the notification level said in words, who is in it in
 * its three states (`UX.md` §8), found by name when there are many and taken out by whoever may
 * (D-172), and Leave and Archive — who
 * is offered each, that each asks first, and what a refusal says.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type {
  Channel,
  ChannelMember,
  MeResponse,
  NotificationLevel,
  UpdateChannelRequest,
} from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WHEN,
  aChannel,
  aUser,
  aSession,
  someChannels,
} from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const inChannel = (...users: (typeof ME)[]): ChannelMember[] =>
  users.map((user) => ({ user, joinedAt: WHEN }));

/** The person as a member of the workspace, not its owner. */
const asMember = (): MeResponse => {
  const session = aSession();
  return {
    ...session,
    memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
  };
};

const openDetails = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'api' }));
  await settle();
  // The details are a deferred chunk (D-163): the first to open in a run waits for it to load.
  return await view.findByRole('dialog', { name: 'Details of #api' });
};

const here = (view: ChannelView): string => view.world.history.stack.at(-1) ?? '';

/** Chooses one of the dialog's tabs, as a pointer does. */
const showTab = async (dialog: HTMLElement, name: RegExp): Promise<void> => {
  await person().click(within(dialog).getByRole('tab', { name }));
  await settle();
};

describe('its tabs', () => {
  test('About is chosen on opening; an owner has Members and Integrations beside it', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME, ALICE)) },
    });
    const dialog = await openDetails(view);
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['About', 'Members2', 'Integrations']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByRole('tabpanel', { name: 'About' })).toBeDefined();
    await showTab(dialog, /^Members/);
    expect(within(dialog).getByRole('tabpanel', { name: /^Members/ })).toBeDefined();
    expect(within(dialog).queryByRole('textbox', { name: 'Name' })).toBeNull();
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('a member who is not an owner or an admin has no Integrations tab', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        me: () => Promise.resolve(asMember()),
        channelMembers: () => Promise.resolve(inChannel(ME)),
      },
    });
    const dialog = await openDetails(view);
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['About', 'Members1']);
    view.unmountAll();
  });

  test('one tab is in the Tab order; arrows move and choose, wrapping, and Home and End go to the ends', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME)) },
    });
    const dialog = await openDetails(view);
    const [about, members, integrations] = within(dialog).getAllByRole('tab');
    if (about === undefined || members === undefined || integrations === undefined) {
      throw new Error('three tabs were expected');
    }
    expect([about, members, integrations].map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    await person().tab();
    expectFocusOn(about);
    await person().keyboard('{ArrowRight}');
    expectFocusOn(members);
    expect(members.getAttribute('aria-selected')).toBe('true');
    expect(members.tabIndex).toBe(0);
    await person().keyboard('{End}');
    expectFocusOn(integrations);
    await person().keyboard('{ArrowRight}');
    expectFocusOn(about);
    await person().keyboard('{ArrowLeft}');
    expectFocusOn(integrations);
    await person().keyboard('{Home}');
    expectFocusOn(about);
    expect(about.getAttribute('aria-selected')).toBe('true');
    view.unmountAll();
  });

  test('a name half typed in About is still there after a look at Members', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME)) },
    });
    const dialog = await openDetails(view);
    await person().type(within(dialog).getByLabelText('Name'), '-two');
    await showTab(dialog, /^Members/);
    await showTab(dialog, /^About/);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('api-two');
    view.unmountAll();
  });

  test('Escape closes it from a tab', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME)) },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmountAll();
  });
});

describe('the notification level', () => {
  test('is said in words in About, and choosing another asks the server', async () => {
    const asked: [string, NotificationLevel][] = [];
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        setNotificationLevel: (channelId, level) => {
          asked.push([channelId, level]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    const dialog = await openDetails(view);
    const group = within(dialog).getByRole('group', { name: 'Notifications' });
    expect(
      within(group).getByRole<HTMLInputElement>('radio', { name: 'Mentions and replies' }).checked,
    ).toBe(true);
    await person().click(within(group).getByRole('radio', { name: 'Nothing' }));
    await settle();
    expect(asked).toEqual([[IDS.api, 'none']]);
    expect(within(group).getByRole<HTMLInputElement>('radio', { name: 'Nothing' }).checked).toBe(
      true,
    );
    view.unmountAll();
  });

  test('is not offered to somebody who has not joined', async () => {
    const view = await mountChannel({
      channelId: IDS.browse,
      messages: page([]),
      api: { me: () => Promise.resolve(asMember()), channelMembers: () => Promise.resolve([]) },
    });
    await person().click(view.getByRole('button', { name: 'browse' }));
    await settle();
    const dialog = view.getByRole('dialog', { name: 'Details of #browse' });
    expect(within(dialog).queryByRole('group', { name: 'Notifications' })).toBeNull();
    view.unmountAll();
  });
});

describe('opening it', () => {
  test('the channel’s name in the header opens it, and the heading is still the name', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME, ALICE)) },
    });
    expect(view.getByRole('heading', { level: 1, name: 'api' })).toBeDefined();
    const dialog = await openDetails(view);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('api');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Topic').value).toBe(
      'Backend deploys and incident follow-ups',
    );
    await showTab(dialog, /^Members/);
    expect(within(dialog).getByRole('heading', { name: 'Members (2)' })).toBeDefined();
    expect(within(dialog).getByText(/@alice/)).toBeDefined();
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('opens on itself, never on the name with its text selected, so a key cannot rename it', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME)) },
    });
    const dialog = await openDetails(view);
    expectFocusOn(dialog);
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name');
    expect(name.selectionEnd === name.selectionStart || document.activeElement !== name).toBe(true);
    await person().keyboard('x');
    expect(name.value).toBe('api');
    view.unmountAll();
  });

  test('a direct message has no channel details: its title opens the person’s profile (D-131)', async () => {
    const direct = { ...aChannel(IDS.api, null), type: 'direct_message' as const, peer: BOB };
    const view = await mountChannel({
      messages: page([]),
      channels: [direct, ...someChannels().filter((c) => c.id !== IDS.api)],
    });
    await person().click(view.getByRole('button', { name: BOB.displayName }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('complementary', { name: /^Profile/ })).toBeDefined();
    view.unmountAll();
  });
});

describe('the topic in the header', () => {
  test('opens the same details for a pointer, though a key reaches them by the name', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME)) },
    });
    const topic = view.getByText('Backend deploys and incident follow-ups');
    expect(topic.closest('button')?.getAttribute('tabindex')).toBe('-1');
    await person().click(topic);
    await settle();
    expect(view.getByRole('dialog', { name: 'Details of #api' })).toBeDefined();
    view.unmountAll();
  });
});

describe('the members', () => {
  test('Add people opens the header’s dialog, and the list is read again when it closes', async () => {
    let asked = 0;
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME }, { user: ALICE }],
      api: {
        channelMembers: () => {
          asked += 1;
          return Promise.resolve(inChannel(ME));
        },
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    const before = asked;
    await person().click(within(dialog).getByRole('button', { name: 'Add people' }));
    await settle();
    expect(view.getByRole('dialog', { name: 'Add people to api' })).toBeDefined();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog', { name: 'Add people to api' })).toBeNull();
    expect(asked).toBeGreaterThan(before);
    view.unmountAll();
  });

  test('say they are loading, say why they failed with Retry, and say when nobody is in it', async () => {
    let answer: () => Promise<ChannelMember[]> = () =>
      Promise.reject(new ApiError(500, 'INTERNAL', 'no'));
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => answer() },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    expect(within(dialog).getByText(/could not be loaded/)).toBeDefined();
    answer = (): Promise<ChannelMember[]> => Promise.resolve([]);
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      within(dialog).getByText('Nobody is in this channel. Anyone can join it.'),
    ).toBeDefined();
    view.unmountAll();

    const slow = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => new Promise<ChannelMember[]>(() => undefined) },
    });
    const loading = await openDetails(slow);
    await showTab(loading, /^Members/);
    expect(within(loading).getByText('Loading')).toBeDefined();
    slow.unmountAll();
  });

  test('more than eight are found by name, with no case, accents or dotless ı in the way', async () => {
    const many = [
      ME,
      ALICE,
      BOB,
      ...['carol', 'deniz', 'emre', 'fatma', 'gökhan'].map((name, n) =>
        aUser(name, `0199155c-6200-7b7f-8c11-0000000000${String(n + 10)}`),
      ),
      { ...aUser('isik', '0199155c-6200-7b7f-8c11-000000000020'), displayName: 'Işık Yılmaz' },
    ];
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(...many)) },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    const find = within(dialog).getByLabelText('Find a member');
    await person().type(find, 'ISIK');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    expect(within(dialog).getByText('Işık Yılmaz')).toBeDefined();
    await person().clear(find);
    await person().type(find, 'nobody');
    expect(within(dialog).getByText('Nobody in this channel matches “nobody”.')).toBeDefined();
    view.unmountAll();
  });

  test('eight or fewer are not given a field to find one by', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { channelMembers: () => Promise.resolve(inChannel(ME, ALICE, BOB)) },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    expect(within(dialog).queryByLabelText('Find a member')).toBeNull();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    view.unmountAll();
  });
});

describe('taking somebody out (D-172)', () => {
  const secret = (): Channel[] => [
    { ...aChannel(IDS.api, 'api'), type: 'private' as const },
    ...someChannels().filter((c) => c.id !== IDS.api),
  ];

  test('an owner is offered Remove on every row but their own; it asks first in the row, and Cancel gives focus back', async () => {
    const removed: string[] = [];
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME, role: 'owner' }, { user: ALICE }, { user: BOB, role: 'admin' }],
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE, BOB)),
        removeChannelMember: (_channel, userId) => {
          removed.push(userId);
          return Promise.resolve();
        },
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    expect(
      within(dialog)
        .getAllByRole('button', { name: /^Remove .* from the channel$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Remove Alice from the channel', 'Remove Bob from the channel']);
    const ask = within(dialog).getByRole('button', { name: 'Remove Alice from the channel' });
    await person().click(ask);
    expect(removed).toEqual([]);
    const question = within(dialog).getByRole('group', { name: 'Remove Alice from the channel' });
    expect(question.textContent).toContain(
      'Remove Alice from #api? Their messages stay, and they can join again.',
    );
    await expectNoAxeViolations(dialog);
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().click(within(question).getByRole('button', { name: 'Cancel' }));
    await settle();
    expectFocusOn(within(dialog).getByRole('button', { name: 'Remove Alice from the channel' }));
    expect(removed).toEqual([]);
    view.unmountAll();
  });

  test('confirmed, the row goes at once — before the server answers — and stays gone', async () => {
    let answer: () => void = () => undefined;
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME, role: 'owner' }, { user: ALICE }],
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE)),
        removeChannelMember: () =>
          new Promise<void>((resolve) => {
            answer = resolve;
          }),
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    await person().click(
      within(dialog).getByRole('button', { name: 'Remove Alice from the channel' }),
    );
    const question = within(dialog).getByRole('group', { name: 'Remove Alice from the channel' });
    await person().click(within(question).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).queryByText('Alice')).toBeNull();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settle();
    expect(within(dialog).queryByText('Alice')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    view.unmountAll();
  });

  test('a refusal puts the row back and says why', async () => {
    let read = 0;
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME, role: 'owner' }, { user: ALICE }],
      api: {
        // Read once: the list asked for again after the refusal never answers, so only putting the
        // row back at once can show her.
        channelMembers: () =>
          (read += 1) === 1
            ? Promise.resolve(inChannel(ME, ALICE))
            : new Promise<ChannelMember[]>(() => undefined),
        removeChannelMember: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    await person().click(
      within(dialog).getByRole('button', { name: 'Remove Alice from the channel' }),
    );
    const question = within(dialog).getByRole('group', { name: 'Remove Alice from the channel' });
    await person().click(within(question).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(within(dialog).getByText('Alice')).toBeDefined();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Only an owner or an admin can remove Alice.',
    );
    view.unmountAll();
  });

  test('a failure it cannot explain is said in words', async () => {
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME, role: 'owner' }, { user: ALICE }],
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE)),
        removeChannelMember: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    await person().click(
      within(dialog).getByRole('button', { name: 'Remove Alice from the channel' }),
    );
    await person().click(
      within(within(dialog).getByRole('group')).getByRole('button', { name: 'Remove' }),
    );
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('Alice was not removed.');
    view.unmountAll();
  });

  test('a member is offered nothing in a public channel', async () => {
    const view = await mountChannel({
      messages: page([]),
      members: [{ user: ME }, { user: ALICE }],
      api: {
        me: () => Promise.resolve(asMember()),
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE)),
      },
    });
    const dialog = await openDetails(view);
    await showTab(dialog, /^Members/);
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).toBeNull();
    view.unmountAll();
  });

  test('in a private channel a member may take out another member, not an admin or an owner — said in Turkish', async () => {
    const view = await mountChannel({
      messages: page([]),
      locale: 'tr',
      channels: secret(),
      members: [{ user: ME }, { user: ALICE }, { user: BOB, role: 'admin' }],
      api: {
        me: () => Promise.resolve(asMember()),
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE, BOB)),
      },
    });
    await person().click(view.getByRole('button', { name: 'api' }));
    await settle();
    const dialog = await view.findByRole('dialog', { name: '#api ayrıntıları' });
    await showTab(dialog, /^Üyeler/);
    expect(
      within(dialog)
        .getAllByRole('button', { name: /kanaldan çıkar$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Alice kişisini kanaldan çıkar']);
    await person().click(
      within(dialog).getByRole('button', { name: 'Alice kişisini kanaldan çıkar' }),
    );
    expect(within(dialog).getByRole('group').textContent).toContain(
      'Alice kişisi #api kanalından çıkarılsın mı? Kanalı artık görmez, mesajları kalır.',
    );
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });
});

describe('the name and the topic', () => {
  test('a name typed the way it is said is saved in the rule’s form, with the topic', async () => {
    const asked: UpdateChannelRequest[] = [];
    // The server's list, as the server keeps it: the list is read again after the answer.
    let list = someChannels();
    const view = await mountChannel({
      messages: page([]),
      api: {
        channels: () => Promise.resolve(list),
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: (_id, input) => {
          asked.push(input);
          const saved = aChannel(IDS.api, input.name ?? 'api', { topic: input.topic ?? null });
          list = list.map((c) => (c.id === IDS.api ? saved : c));
          return Promise.resolve(saved);
        },
      },
    });
    const dialog = await openDetails(view);
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name');
    await person().clear(name);
    await person().type(name, 'Genel Sohbet');
    expect(name.value).toBe('genel-sohbet');
    const topic = within(dialog).getByLabelText<HTMLInputElement>('Topic');
    // Emptied key by key, as a person does it: an empty topic is sent as none.
    await person().type(topic, '{Backspace}'.repeat(topic.value.length));
    expect(topic.value).toBe('');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(asked).toEqual([{ name: 'genel-sohbet', topic: null }]);
    expect(within(dialog).getByText('Saved.')).toBeDefined();
    // The header reads from the same list the answer was written to.
    // Behind the dialog, so hidden from the accessibility tree while it is open.
    expect(
      view.getByRole('heading', { level: 1, name: 'genel-sohbet', hidden: true }),
    ).toBeDefined();
    view.unmountAll();
  });

  test('a name with nothing left of it is refused before the server hears', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: () => Promise.reject(new Error('the server must not be asked')),
      },
    });
    const dialog = await openDetails(view);
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name');
    await person().type(name, '{Backspace}'.repeat(name.value.length));
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('Use lowercase letters');
    view.unmountAll();
  });

  test.each([
    [
      'a topic the server refuses is said under the topic',
      new ApiError(400, 'VALIDATION_FAILED', 'x', { topic: 'not plain text' }),
      'Topic',
    ],
    [
      'a name the server refuses is said under the name',
      new ApiError(400, 'VALIDATION_FAILED', 'x', { name: 'not a name' }),
      'Name',
    ],
  ])('%s', async (_why, failure, field) => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: () => Promise.reject(failure),
      },
    });
    const dialog = await openDetails(view);
    await person().type(within(dialog).getByLabelText('Topic'), '!');
    await person().type(within(dialog).getByLabelText('Name'), 'x');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    const box = within(dialog).getByLabelText(field);
    const described = box.getAttribute('aria-describedby') ?? '';
    const said = described
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(said).toContain(field === 'Topic' ? 'Write the topic' : 'Use lowercase');
    view.unmountAll();
  });

  test('a failure it cannot explain is said in words', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
      },
    });
    const dialog = await openDetails(view);
    await person().type(within(dialog).getByLabelText('Topic'), '!');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('was not saved');
    view.unmountAll();
  });

  test('saving only the topic sends only the topic: a name in an older form is not rewritten', async () => {
    const asked: UpdateChannelRequest[] = [];
    const old = aChannel(IDS.api, 'Genel Sohbet');
    const view = await mountChannel({
      messages: page([]),
      channels: [old, ...someChannels().filter((c) => c.id !== IDS.api)],
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: (_id, input) => {
          asked.push(input);
          return Promise.resolve({ ...old, topic: input.topic ?? null });
        },
      },
    });
    await person().click(view.getByRole('button', { name: 'Genel Sohbet' }));
    await settle();
    const dialog = view.getByRole('dialog');
    const save = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    await person().type(within(dialog).getByLabelText('Topic'), 'Weekly');
    await person().click(save);
    await settle();
    expect(asked).toEqual([{ topic: 'Weekly' }]);
    view.unmountAll();
  });

  test('a rename by somebody else while it is open is shown, and saving the topic does not undo it', async () => {
    const asked: UpdateChannelRequest[] = [];
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: (_id, input) => {
          asked.push(input);
          return Promise.resolve(aChannel(IDS.api, 'backend', { topic: input.topic ?? null }));
        },
      },
    });
    const dialog = await openDetails(view);
    const list = view.world.client.getQueryData<Channel[]>(keys.channels(IDS.workspace)) ?? [];
    act(() => {
      view.world.client.setQueryData<Channel[]>(
        keys.channels(IDS.workspace),
        list.map((c) => (c.id === IDS.api ? { ...c, name: 'backend' } : c)),
      );
    });
    await settle();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('backend');
    await person().type(within(dialog).getByLabelText('Topic'), '!');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(asked).toEqual([{ topic: 'Backend deploys and incident follow-ups!' }]);
    view.unmountAll();
  });

  test('after its own answer, the list is read again: a rename that overtook it is not hidden', async () => {
    let reads = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        channels: () => {
          reads += 1;
          return Promise.resolve(someChannels());
        },
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: (_id, input) => Promise.resolve(aChannel(IDS.api, input.name ?? 'api')),
      },
    });
    const dialog = await openDetails(view);
    const before = reads;
    await person().type(within(dialog).getByLabelText('Name'), '-x');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(reads).toBe(before + 1);
    view.unmountAll();
  });

  test('a taken name is said under the name, and what was typed stays', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: () => Promise.reject(new ApiError(409, 'CHANNEL_NAME_TAKEN', 'x')),
      },
    });
    const dialog = await openDetails(view);
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name');
    await person().type(name, '-two');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('already exists');
    expect(name.value).toBe('api-two');
    view.unmountAll();
  });

  test('somebody who has not joined is shown them, and offered nothing to change or leave', async () => {
    const view = await mountChannel({
      channelId: IDS.browse,
      messages: page([]),
      api: { me: () => Promise.resolve(asMember()), channelMembers: () => Promise.resolve([]) },
    });
    await person().click(view.getByRole('button', { name: 'browse' }));
    await settle();
    const dialog = view.getByRole('dialog', { name: 'Details of #browse' });
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    expect(within(dialog).getByText(/Join the channel to change/)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Leave channel' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Archive channel' })).toBeNull();
    view.unmountAll();
  });
});

describe('leaving and archiving', () => {
  test('the question takes focus on Cancel, says what it asks, and Cancel gives focus back to the button that asked', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        me: () => Promise.resolve(asMember()),
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE)),
      },
    });
    const dialog = await openDetails(view);
    const leave = within(dialog).getByRole('button', { name: 'Leave channel' });
    act(() => {
      leave.focus();
    });
    await person().keyboard('{Enter}');
    await settle();
    const question = within(dialog).getByRole('group', { name: /Leave #api\?/ });
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().keyboard('{Enter}');
    await settle();
    expectFocusOn(within(dialog).getByRole('button', { name: 'Leave channel' }));
    view.unmountAll();
  });

  test('a member is offered Leave and not Archive; Leave asks first, then goes, and the channel leaves the list', async () => {
    const left: string[] = [];
    const view = await mountChannel({
      messages: page([]),
      api: {
        me: () => Promise.resolve(asMember()),
        channelMembers: () => Promise.resolve(inChannel(ME, ALICE)),
        leaveChannel: (id) => {
          left.push(id);
          return Promise.resolve();
        },
      },
    });
    const dialog = await openDetails(view);
    expect(within(dialog).queryByRole('button', { name: 'Archive channel' })).toBeNull();
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    expect(left).toEqual([]);
    expect(within(dialog).getByText(/Leave #api\?/)).toBeDefined();
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await settle();
    expect(left).toEqual([IDS.api]);
    expect(here(view)).toBe('/w/acme');
    view.unmountAll();
  });

  test('the last member of a private channel is told what to do instead', async () => {
    const secret = { ...aChannel(IDS.api, 'api'), type: 'private' as const };
    const view = await mountChannel({
      messages: page([]),
      channels: [secret, ...someChannels().filter((c) => c.id !== IDS.api)],
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        leaveChannel: () => Promise.reject(new ApiError(409, 'LAST_CHANNEL_MEMBER', 'x')),
      },
    });
    const dialog = await openDetails(view);
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('Bring somebody in first');
    view.unmountAll();
  });

  test('an archive that fails says so, and the channel stays', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        archiveChannel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
      },
    });
    const dialog = await openDetails(view);
    const where = [...view.world.history.stack];
    await person().click(within(dialog).getByRole('button', { name: 'Archive channel' }));
    await person().click(within(dialog).getByRole('button', { name: 'Archive channel' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('was not archived');
    expect(view.world.history.stack).toEqual(where);
    view.unmountAll();
  });

  test('an owner archives after being asked, and is taken to the workspace', async () => {
    const archived: string[] = [];
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        archiveChannel: (id) => {
          archived.push(id);
          return Promise.resolve();
        },
      },
    });
    const dialog = await openDetails(view);
    await person().click(within(dialog).getByRole('button', { name: 'Archive channel' }));
    expect(within(dialog).getByText(/Archive #api\?/)).toBeDefined();
    await expectNoAxeViolations(dialog);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(archived).toEqual([]);
    await person().click(within(dialog).getByRole('button', { name: 'Archive channel' }));
    await person().click(within(dialog).getByRole('button', { name: 'Archive channel' }));
    await settle();
    expect(archived).toEqual([IDS.api]);
    expect(here(view)).toBe('/w/acme');
    view.unmountAll();
  });
});
