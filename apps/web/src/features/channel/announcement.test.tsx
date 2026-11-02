/**
 * An announcement channel on screen (D-243): who is given the composer and who is told, in its place,
 * that only owners and admins post here — with the thread's composer still theirs — the marker in the
 * header, and the box in the channel's details that says it, for whoever may.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { MeResponse, ThreadPage, UpdateChannelRequest, UserRole } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  IDS,
  ME,
  WHEN,
  aChannel,
  aMessage,
  aSession,
  messageIdAt,
  someChannels,
} from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const ROOT = 2;

/** The person, with this role in the workspace. */
const as = (role: UserRole): MeResponse => {
  const session = aSession();
  return { ...session, memberships: session.memberships.map((m) => ({ ...m, role })) };
};

/** `#api`, an announcement channel or not, beside the rest of the workspace's. */
const channelsWith = (onlyAdminsPost: boolean): ReturnType<typeof someChannels> => [
  aChannel(IDS.api, 'api', { onlyAdminsPost }),
  ...someChannels().filter((c) => c.id !== IDS.api),
];

const mountAs = async (
  role: UserRole,
  options: {
    readonly onlyAdminsPost?: boolean;
    readonly path?: string;
    readonly locale?: 'tr';
  } = {},
): Promise<ChannelView> =>
  await mountChannel({
    channels: channelsWith(options.onlyAdminsPost ?? true),
    messages: page([
      aMessage(1),
      aMessage(ROOT, {
        content: 'Bakım cuma',
        thread: { replyCount: 1, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null },
      }),
    ]),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    api: {
      me: () => Promise.resolve(as(role)),
      thread: (): Promise<ThreadPage> =>
        Promise.resolve({
          data: [aMessage(3, { parentId: messageIdAt(ROOT), thread: null, content: 'Tamam' })],
          nextCursor: null,
        }),
      channelMembers: () => Promise.resolve([{ user: ME, joinedAt: WHEN }]),
    },
  });

const NOTICE = 'Only owners and admins post in this channel. You can still reply in a thread.';

describe('the composer of an announcement channel', () => {
  test('a member is told who posts here in its place, the header marks it, and the page passes the audit', async () => {
    const view = await mountAs('member');
    expect(view.getByText(NOTICE)).toBeDefined();
    expect(view.queryByLabelText('Message api')).toBeNull();
    expect(view.getByRole('img', { name: 'Only owners and admins post here' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a member still replies in a thread: its composer is there', async () => {
    const view = await mountAs('member', {
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}`,
    });
    expect(view.getByText(NOTICE)).toBeDefined();
    expect(view.getByLabelText('Message a thread in api')).toBeDefined();
    view.unmountAll();
  });

  test.each(['owner', 'admin'] as const)('an %s has the composer', async (role) => {
    const view = await mountAs(role);
    expect(view.getByLabelText('Message api')).toBeDefined();
    expect(view.queryByText(NOTICE)).toBeNull();
    // The marker is for everybody: it says what the channel is, not what this person may do.
    expect(view.getByRole('img', { name: 'Only owners and admins post here' })).toBeDefined();
    view.unmountAll();
  });

  test('a channel everybody posts in has neither the notice nor the marker', async () => {
    const view = await mountAs('member', { onlyAdminsPost: false });
    expect(view.getByLabelText('Message api')).toBeDefined();
    expect(view.queryByText(NOTICE)).toBeNull();
    expect(view.queryByRole('img', { name: 'Only owners and admins post here' })).toBeNull();
    view.unmountAll();
  });

  test('turned off while it is open, the composer comes back; turned on again, it goes', async () => {
    const view = await mountAs('member');
    view.world.client.setQueryData(keys.channels(IDS.workspace), channelsWith(false));
    await settle();
    expect(view.getByLabelText('Message api')).toBeDefined();
    view.world.client.setQueryData(keys.channels(IDS.workspace), channelsWith(true));
    await settle();
    expect(view.getByText(NOTICE)).toBeDefined();
    view.unmountAll();
  });

  test('speaks Turkish', async () => {
    const view = await mountAs('member', { locale: 'tr' });
    expect(
      view.getByText(
        'Bu kanala yalnızca sahipler ve yöneticiler yazar. Yine de bir thread’e yanıt yazabilirsin.',
      ),
    ).toBeDefined();
    view.unmountAll();
  });
});

describe('saying who posts, in the channel’s details', () => {
  const openDetails = async (view: ChannelView): Promise<HTMLElement> => {
    await person().click(view.getByRole('button', { name: 'api' }));
    await settle();
    return await view.findByRole('dialog', { name: 'Details of #api' });
  };

  test('an owner ticks it: painted at once, and the server is asked for exactly that', async () => {
    const asked: UpdateChannelRequest[] = [];
    const view = await mountChannel({
      channels: channelsWith(false),
      messages: page([]),
      api: {
        channelMembers: () => Promise.resolve([{ user: ME, joinedAt: WHEN }]),
        updateChannel: (_id, input) => {
          asked.push(input);
          return new Promise(() => undefined);
        },
      },
    });
    const dialog = await openDetails(view);
    const box = within(dialog).getByRole<HTMLInputElement>('checkbox', {
      name: /Only owners and admins can post/,
    });
    expect(box.checked).toBe(false);
    await person().click(box);
    await settle();
    expect(asked).toEqual([{ onlyAdminsPost: true }]);
    expect(box.checked).toBe(true);
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('a refusal puts the box back as the server has it, and says why', async () => {
    const view = await mountChannel({
      channels: channelsWith(true),
      messages: page([]),
      api: {
        me: () => Promise.resolve(as('admin')),
        channelMembers: () => Promise.resolve([{ user: ME, joinedAt: WHEN }]),
        updateChannel: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'demoted')),
      },
    });
    const dialog = await openDetails(view);
    const box = within(dialog).getByRole<HTMLInputElement>('checkbox', {
      name: /Only owners and admins can post/,
    });
    await person().click(box);
    await settle();
    expect(box.checked).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toContain('The change was not saved.');
    view.unmountAll();
  });

  test('a member is not offered it', async () => {
    const view = await mountAs('member');
    const dialog = await openDetails(view);
    expect(within(dialog).queryByRole('group', { name: 'Posting' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    view.unmountAll();
  });
});
