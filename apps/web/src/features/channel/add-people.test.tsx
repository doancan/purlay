/**
 * Bringing people into a channel from its header (D-104): who sees the button, the three states of
 * the list (`UX.md` §8), narrowing it, adding, and what a refusal says.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
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
  someChannels,
  NO_PROFILE,
} from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const people = (...users: (typeof ME)[]): { user: typeof ME }[] => users.map((user) => ({ user }));

const openPeople = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'Add people' }));
  return view.getByRole('dialog', { name: /Add people to/ });
};

describe('the button', () => {
  test('is in the header of a channel the person is in, private or not', async () => {
    const secret = { ...aChannel(IDS.api, 'leads'), type: 'private' as const };
    const view = await mountChannel({
      messages: page([]),
      channels: [secret, ...someChannels().filter((c) => c.id !== IDS.api)],
    });
    expect(view.getByRole('button', { name: 'Add people' })).toBeDefined();
    view.unmountAll();
  });

  test('is not in a direct message, which stays between its two people', async () => {
    const direct = {
      ...aChannel(IDS.api, null),
      type: 'direct_message' as const,
      peer: BOB,
    };
    const view = await mountChannel({
      messages: page([]),
      channels: [direct, ...someChannels().filter((c) => c.id !== IDS.api)],
    });
    expect(view.queryByRole('button', { name: 'Add people' })).toBeNull();
    view.unmountAll();
  });
});

describe('the list', () => {
  test('is everybody else in the workspace, narrowed as you type, and adding says so', async () => {
    const asked: string[] = [];
    const view = await mountChannel({
      messages: page([]),
      members: people(ME, ALICE, BOB),
      api: {
        addChannelMember: (_channel, userId) => {
          asked.push(userId);
          return Promise.resolve();
        },
      },
    });
    const dialog = await openPeople(view);
    await settle();
    expect(within(dialog).queryByText(new RegExp(`@${ME.username}`))).toBeNull();
    expect(within(dialog).getByText(new RegExp(`@${ALICE.username}`))).toBeDefined();
    await person().type(within(dialog).getByLabelText('Find a person'), BOB.username);
    expect(within(dialog).queryByText(new RegExp(`@${ALICE.username}`))).toBeNull();
    await person().click(within(dialog).getByRole('button', { name: 'Add' }));
    await settle();
    expect(asked).toEqual([BOB.id]);
    const done = within(dialog).getByRole('button', { name: 'Added' });
    expect(done.hasAttribute('disabled')).toBe(true);
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('somebody already in the channel is a member, not somebody to add, and listed after', async () => {
    // Found by an audit: every member of the channel had an Add of their own, which did nothing.
    const view = await mountChannel({
      messages: page([]),
      members: people(ME, ALICE, BOB),
      api: {
        channelMembers: () =>
          Promise.resolve([ME, ALICE].map((user) => ({ user, joinedAt: WHEN }))),
      },
    });
    const dialog = await openPeople(view);
    await settle();
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      `BO${BOB.displayName} @${BOB.username}Add`,
      `AL${ALICE.displayName} @${ALICE.username}Member`,
    ]);
    expect(within(dialog).getAllByRole('button', { name: 'Add' })).toHaveLength(1);
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('closed and opened again, it starts afresh: no filter, nobody marked added', async () => {
    const view = await mountChannel({
      messages: page([]),
      members: people(ME, ALICE),
      api: { addChannelMember: () => Promise.resolve() },
    });
    const dialog = await openPeople(view);
    await settle();
    await person().type(within(dialog).getByLabelText('Find a person'), ALICE.username);
    await person().click(within(dialog).getByRole('button', { name: 'Add' }));
    await settle();
    await person().keyboard('{Escape}');
    expect(view.queryByRole('dialog')).toBeNull();
    const again = await openPeople(view);
    await settle();
    expect(within(again).getByLabelText<HTMLInputElement>('Find a person').value).toBe('');
    expect(within(again).getByRole('button', { name: 'Add' })).toBeDefined();
    view.unmountAll();
  });

  test('says when nobody matches, and when nobody else is in the workspace', async () => {
    const view = await mountChannel({ messages: page([]), members: people(ME, ALICE) });
    const dialog = await openPeople(view);
    await settle();
    await person().type(within(dialog).getByLabelText('Find a person'), 'zz');
    expect(within(dialog).getByText('Nobody by that name.')).toBeDefined();
    view.unmountAll();

    const alone = await mountChannel({ messages: page([]), members: people(ME) });
    const empty = await openPeople(alone);
    await settle();
    expect(within(empty).getByText('Nobody else is in this workspace yet.')).toBeDefined();
    alone.unmountAll();
  });

  test('says it is loading, and says why when it fails, with Retry', async () => {
    let fail = true;
    const view = await mountChannel({
      messages: page([]),
      api: {
        members: () =>
          fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'no'))
            : Promise.resolve(
                [ME, ALICE].map((user) => ({
                  user,
                  role: 'member' as const,
                  joinedAt: WHEN,
                  profile: NO_PROFILE,
                })),
              ),
      },
    });
    const dialog = await openPeople(view);
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'The people of this workspace could not be loaded.',
    );
    fail = false;
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(dialog).getByText(new RegExp(`@${ALICE.username}`))).toBeDefined();
    view.unmountAll();
  });

  test('a refusal is said beside the person, and Add can be tried again', async () => {
    const view = await mountChannel({
      messages: page([]),
      members: people(ME, ALICE),
      api: { addChannelMember: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')) },
    });
    const dialog = await openPeople(view);
    await settle();
    await person().click(within(dialog).getByRole('button', { name: 'Add' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      `${ALICE.displayName} was not added.`,
    );
    expect(within(dialog).getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(
      false,
    );
    view.unmountAll();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await mountChannel({
      messages: page([]),
      members: people(ME, ALICE),
      locale: 'tr',
    });
    await person().click(view.getByRole('button', { name: 'Kişi ekle' }));
    await settle();
    const dialog = view.getByRole('dialog', { name: /kanalına kişi ekle/ });
    expect(within(dialog).getByRole('button', { name: 'Ekle' })).toBeDefined();
    view.unmountAll();
  });
});
