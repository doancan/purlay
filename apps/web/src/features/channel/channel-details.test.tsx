/**
 * A channel's details, opened from its name in the header (D-123): the name and topic, who is in
 * it in its three states (`UX.md` §8), and Leave and Archive — who is offered each, that each asks
 * first, and what a refusal says.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Channel, ChannelMember, MeResponse, UpdateChannelRequest } from '@purlay/types';
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
  return view.getByRole('dialog', { name: 'Details of #api' });
};

const here = (view: ChannelView): string => view.world.history.stack.at(-1) ?? '';

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
    expect(within(loading).getByText('Loading')).toBeDefined();
    slow.unmountAll();
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
