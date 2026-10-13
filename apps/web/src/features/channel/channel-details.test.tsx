/**
 * A channel's details, opened from its name in the header (D-123): the name and topic, and who is
 * in it in its three states (`UX.md` §8).
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { ChannelMember, MeResponse, UpdateChannelRequest } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
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

  test('a direct message has no details to open: its title is not a button', async () => {
    const direct = { ...aChannel(IDS.api, null), type: 'direct_message' as const, peer: BOB };
    const view = await mountChannel({
      messages: page([]),
      channels: [direct, ...someChannels().filter((c) => c.id !== IDS.api)],
    });
    expect(view.queryByRole('button', { name: BOB.username })).toBeNull();
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
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: (_id, input) => {
          asked.push(input);
          return Promise.resolve(
            aChannel(IDS.api, input.name ?? 'api', { topic: input.topic ?? null }),
          );
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
    ['a name the server refuses', new ApiError(400, 'VALIDATION_FAILED', 'x'), 'Use lowercase'],
    ['a failure it cannot explain', new ApiError(500, 'INTERNAL', 'x'), 'was not saved'],
  ])('%s is said in words', async (_why, failure, words) => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve(inChannel(ME)),
        updateChannel: () => Promise.reject(failure),
      },
    });
    const dialog = await openDetails(view);
    await person().type(within(dialog).getByLabelText('Topic'), '!');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(words);
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

  test('somebody who has not joined is shown them, and offered nothing to change', async () => {
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
    view.unmountAll();
  });
});
