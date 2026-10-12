/**
 * A channel's screen: the states every view has (`UX.md` §8), what is in the header, a
 * channel the person has not joined, and the feed in the languages it speaks.
 */
import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { page, mountChannel, settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  aChannel,
  aMessage,
  someChannels,
  messageIdAt,
} from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const never = (): Promise<never> => new Promise(() => undefined);

describe('loading', () => {
  test('is skeleton rows with one announcement, never a spinner, and passes the audit', async () => {
    const view = await mountChannel({ messages: never });
    expect(
      view.getAllByRole('status').some((node) => node.textContent === 'Loading messages'),
    ).toBe(true);
    expect(view.container.querySelector('[role="feed"]')).toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('while the channel list loads the screen waits, and a channel that is not in it says so', async () => {
    const waiting = await mountChannel({ api: { channels: never } });
    expect(waiting.getAllByRole('status').some((node) => node.textContent === 'Loading')).toBe(
      true,
    );
    waiting.unmountAll();

    const missing = await mountChannel({ channelId: '00000000-0000-4000-8000-0000000000ff' });
    expect(
      missing.getByRole('heading', { level: 1, name: 'That channel is not here' }),
    ).toBeDefined();
    missing.unmountAll();
  });
});

describe('a feed that failed to load', () => {
  test('says what happened, offers Retry, leaves the composer usable, and Retry asks again', async () => {
    let attempts = 0;
    const view = await mountChannel({
      messages: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(page([aMessage(1)]));
      },
    });
    expect(view.getByRole('alert').textContent).toContain("Couldn't load messages");
    expect(view.getByLabelText('Message api')).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('message 1')).toBeDefined();
    view.unmountAll();
  });
});

describe('an empty channel', () => {
  test('is an invitation, not a blank', async () => {
    const view = await mountChannel({ messages: page([]) });
    expect(view.getByRole('heading', { name: 'No messages yet' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });
});

describe('the header', () => {
  test('names the channel in the mono face, with its topic, and the two views', async () => {
    const view = await mountChannel({ messages: page([aMessage(1)]) });
    const title = view.getByRole('heading', { level: 1 });
    expect(title.textContent).toBe('api');
    // A place you go is named in the sans; the mono is for what is machine text (D-109).
    expect(title.className).not.toContain('font-mono');
    expect(title.className).toContain('text-heading');
    expect(view.getByText('Backend deploys and incident follow-ups')).toBeDefined();
    const feedTab = view.getByRole('link', { name: 'Feed' });
    expect(feedTab.getAttribute('aria-current')).toBe('page');
    expect(feedTab.getAttribute('href')).toBe(`/w/acme/c/${IDS.api}`);
    expect(view.getByRole('link', { name: 'Open questions' }).getAttribute('href')).toBe(
      '/w/acme/questions',
    );
    view.unmountAll();
  });

  test('draws the two views as one segmented control: a track, with the current view raised out of it', async () => {
    const view = await mountChannel({ messages: page([aMessage(1)]) });
    const track = view.getByRole('navigation', { name: 'Channel views' });
    expect(track.className).toContain('rounded-lg');
    expect(track.className).toContain('bg-surface-200');
    expect(track.querySelectorAll('a')).toHaveLength(2);
    const raised = view.getByRole('link', { name: 'Feed' });
    expect(raised.className).toContain('bg-surface-100');
    expect(raised.className).toContain('shadow-card');
    // The one that is not current is on the track, not raised.
    expect(view.getByRole('link', { name: 'Open questions' }).className).not.toContain(
      'bg-surface-100',
    );
    // The glyph beside the name stands for a channel and says nothing a screen reader needs.
    expect(
      view.getByRole('heading', { level: 1 }).previousElementSibling?.getAttribute('aria-hidden'),
    ).toBe('true');
    view.unmountAll();
  });

  test('says there is no topic yet, without making one up', async () => {
    const view = await mountChannel({
      channelId: IDS.deploys,
      messages: page([aMessage(1, { channelId: IDS.deploys })]),
    });
    expect(view.getByText('No topic yet')).toBeDefined();
    view.unmountAll();
  });

  test('shows the live count of open questions, and a floor when there are more pages', async () => {
    const open = [aMessage(5), aMessage(6)];
    const some = await mountChannel({
      messages: page([aMessage(1)]),
      api: { unresolved: () => Promise.resolve(page(open)) },
    });
    expect(some.getByRole('link', { name: /Open questions/ }).textContent).toContain('2');
    some.unmountAll();

    const many = await mountChannel({
      messages: page([aMessage(1)]),
      api: { unresolved: () => Promise.resolve(page(open, messageIdAt(4))) },
    });
    expect(many.getByRole('link', { name: /Open questions/ }).textContent).toContain('2+');
    many.unmountAll();

    const none = await mountChannel({ messages: page([aMessage(1)]) });
    expect(none.getByRole('link', { name: 'Open questions' }).textContent).toBe('Open questions');
    none.unmountAll();
  });

  test('a direct message is the other person, and a note to self says so', async () => {
    const dm = aChannel(IDS.dm, null, { type: 'direct_message', peer: BOB });
    const self = aChannel(IDS.dm, null, { type: 'direct_message', peer: ME });
    const other = await mountChannel({
      channelId: IDS.dm,
      channels: [dm],
      messages: page([aMessage(1, { channelId: IDS.dm })]),
    });
    expect(other.getByRole('heading', { level: 1 }).textContent).toBe('bob');
    // A conversation with a person is headed by the person's own avatar, not a glyph.
    expect(other.getByRole('heading', { level: 1 }).previousElementSibling?.textContent).toBe('BO');
    expect(other.queryByText('No topic yet')).toBeNull();
    other.unmountAll();
    const note = await mountChannel({
      channelId: IDS.dm,
      channels: [self],
      messages: page([aMessage(1, { channelId: IDS.dm })]),
    });
    expect(note.getByRole('heading', { level: 1 }).textContent).toBe('dogancan (you)');
    note.unmountAll();
    const odd = await mountChannel({
      channelId: IDS.dm,
      channels: [aChannel(IDS.dm, 'legacy', { type: 'direct_message' })],
      messages: page([aMessage(1, { channelId: IDS.dm })]),
    });
    expect(odd.getByRole('heading', { level: 1 }).textContent).toBe('legacy');
    odd.unmountAll();
  });
});

describe('a channel the person has not joined', () => {
  const channels = someChannels();

  test('shows its messages and a way to join in place of the composer', async () => {
    const view = await mountChannel({
      channelId: IDS.browse,
      channels,
      messages: page([aMessage(1, { channelId: IDS.browse })]),
    });
    expect(view.getByText('message 1')).toBeDefined();
    expect(view.getByText('You are reading #browse without being a member.')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('joining asks the API, and a failure is said in words and can be tried again', async () => {
    let joined = 0;
    let fail = true;
    const view = await mountChannel({
      channelId: IDS.browse,
      channels,
      messages: page([aMessage(1, { channelId: IDS.browse })]),
      api: {
        joinChannel: () => {
          joined += 1;
          return fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'broke'))
            : Promise.resolve(aChannel(IDS.browse, 'browse'));
        },
      },
    });
    const user = person();
    await user.click(view.getByRole('button', { name: 'Join channel' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Could not join the channel');
    fail = false;
    await user.click(view.getByRole('button', { name: 'Join channel' }));
    await settle();
    expect(joined).toBe(2);
    expect(view.queryByRole('alert')).toBeNull();
    view.unmountAll();
  });
});

describe('the feed, populated', () => {
  const rich = [
    aMessage(1, { sender: ALICE, content: 'merged the fix' }),
    aMessage(2, {
      sender: ALICE,
      content: 'staging is green',
      createdAt: new Date(Date.UTC(2026, 8, 9, 8, 1, 0)).toISOString(),
    }),
    aMessage(3, {
      sender: BOB,
      content: 'hi @dogancan, see https://example.test',
      mentions: [ME.id],
    }),
    aMessage(4, {
      sender: ALICE,
      content: '```ts\nconst a = 1;\n```',
      reactions: [{ emoji: '👍', userIds: [ME.id, BOB.id] }],
    }),
  ];

  test('groups what is the same author within five minutes and marks the mention', async () => {
    const view = await mountChannel({ messages: page(rich) });
    const rows = view.container.querySelectorAll('[data-message-row]');
    expect(rows).toHaveLength(4);
    // The second row has no name: it is under the first.
    expect(rows[0]?.textContent).toContain('alice');
    expect(rows[1]?.textContent).not.toContain('alice');
    expect(rows[2]?.className).toContain('bg-accent-subtle');
    expect(rows[2]?.textContent).toContain('You were mentioned');
    expect(view.getByRole('link', { name: /example\.test/ })).toBeDefined();
    view.unmountAll();
  });

  test("a mention the server resolved is highlighted in the feed, using the workspace's members", async () => {
    const view = await mountChannel({
      members: [{ user: ME }, { user: BOB }],
      messages: page([
        aMessage(1, { sender: BOB, content: 'ping @dogancan and @nobody', mentions: [ME.id] }),
      ]),
    });
    expect(view.getByText('@dogancan').className).toContain('text-accent-text');
    expect(view.container.querySelectorAll('[data-mention]')).toHaveLength(1);
    view.unmountAll();
  });

  test('every time is a real <time> with the full time on hover, and the day is said', async () => {
    const view = await mountChannel({ messages: page(rich) });
    const time = view.container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(rich[0]?.createdAt);
    expect(time?.getAttribute('title')).toContain('Sep 9, 2026');
    expect(view.container.textContent).toContain('Today');
    view.unmountAll();
  });

  test('the day is a label at the left with a rule after it (D-109)', async () => {
    const view = await mountChannel({ messages: page(rich) });
    const label = Array.from(view.container.querySelectorAll('span')).find(
      (node) => node.textContent === 'Today',
    );
    expect(label?.parentElement?.className).not.toContain('justify-center');
    expect(label?.nextElementSibling?.className).toContain('border-t-hairline');
    expect(label?.parentElement?.firstElementChild).toBe(label ?? null);
    expect(view.container.querySelector('[role="feed"]')?.className).toContain('max-w-feed');
    view.unmountAll();
  });

  test.each([false, true])(
    'passes the audit with every kind of row on screen (dark: %s)',
    async (dark) => {
      const view = await mountChannel({ messages: page(rich), dark });
      await expectNoAxeViolations(view.container);
      view.unmountAll();
    },
  );

  test('speaks Turkish: the feed, the row labels and the empty state', async () => {
    const view = await mountChannel({ messages: page(rich), locale: 'tr' });
    expect(view.getByRole('feed', { name: 'api kanalındaki mesajlar' })).toBeDefined();
    expect(view.container.textContent).toContain('Bugün');
    view.unmountAll();
    const empty = await mountChannel({ messages: page([]), locale: 'tr' });
    expect(empty.getByRole('heading', { name: 'Henüz mesaj yok' })).toBeDefined();
    empty.unmountAll();
  });
});
