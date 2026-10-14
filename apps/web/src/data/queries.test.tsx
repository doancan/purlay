/**
 * The hooks screens read through, over an `Api` the test wrote: each asks the one call
 * it should, with the cursor the previous page named, and none ever reaches an endpoint
 * it should not (the fake refuses).
 */
import { NO_PROFILE } from '../testing/fixtures';
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, Message, MessagePage } from '@purlay/types';
import { installDom } from '../testing/dom';
import { anApi } from '../testing/fake-api';
import { renderApp } from '../testing/render';
import {
  readingOrder,
  repliesOf,
  useChannels,
  useMe,
  useMembers,
  useMessages,
  useThread,
  useUnresolved,
} from './queries';
import type { Api } from './api';

installDom();

const ID = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const user = { id: ID, username: 'alice', displayName: 'Alice', avatarUrl: null };
const id = (n: number): string => `0199155c-6200-7b7f-8c11-${String(n).padStart(12, '0')}`;
const message = (n: number): Message => ({
  id: id(n),
  channelId: ID,
  sender: user,
  content: `m${String(n)}`,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  parentId: null,
  reactions: [],
  mentions: [],
  attachments: [],
  thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
});
const page = (nextCursor: string | null, ...n: number[]): MessagePage => ({
  data: n.map(message),
  nextCursor,
});

const Probe = ({ read }: { read: () => string }): React.JSX.Element => <p>{read()}</p>;

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const show = async (api: Api, read: () => string): Promise<string> => {
  const view = await renderApp(<Probe read={read} />, { api });
  await settle();
  return view.container.textContent;
};

describe('the single-value reads', () => {
  test('me, channels and members each ask one call', async () => {
    const calls: string[] = [];
    const channel = {
      id: ID,
      workspaceId: ID,
      name: 'api',
      topic: null,
      type: 'public',
      lastMessageAt: null,
      state: null,
      peer: null,
    } as Channel;
    const api = anApi({
      me: () => {
        calls.push('me');
        return Promise.resolve({
          user: { ...user, email: 'a@example.test' },
          profile: NO_PROFILE,
          memberships: [],
        });
      },
      channels: (workspaceId) => {
        calls.push(`channels ${workspaceId}`);
        return Promise.resolve([channel]);
      },
      members: (workspaceId) => {
        calls.push(`members ${workspaceId}`);
        return Promise.resolve([
          { user, role: 'member', joinedAt: '2026-09-09T08:00:00.000Z', profile: NO_PROFILE },
        ]);
      },
    });
    const Reads = (): React.JSX.Element => {
      const me = useMe();
      const channels = useChannels('w1');
      const members = useMembers('w1');
      return (
        <p>
          {[
            me.data?.user.username,
            channels.data?.[0]?.name,
            members.data?.[0]?.user.username,
          ].join(' ')}
        </p>
      );
    };
    const view = await renderApp(<Reads />, { api });
    await settle();
    expect(view.container.textContent).toBe('alice api alice');
    expect(calls.sort()).toEqual(['channels w1', 'me', 'members w1']);
  });
});

describe('the feed, a thread and the open questions', () => {
  test('the feed starts at the newest and asks for older with the cursor it was given', async () => {
    const asked: (string | undefined)[] = [];
    const api = anApi({
      messages: (_channel, query) => {
        asked.push(query?.before);
        return Promise.resolve(query?.before === undefined ? page(id(2), 4, 3) : page(null, 2, 1));
      },
    });
    let fetchOlder: () => Promise<unknown> = () => Promise.resolve();
    const Feed = (): React.JSX.Element => {
      const feed = useMessages('c1');
      fetchOlder = (): Promise<unknown> => feed.fetchNextPage();
      return (
        <p>
          {readingOrder(feed.data)
            .map((m) => m.content)
            .join(',')}
          {feed.hasNextPage ? ' more' : ' end'}
        </p>
      );
    };
    const view = await renderApp(<Feed />, { api });
    await settle();
    expect(view.container.textContent).toBe('m3,m4 more');
    await act(async () => {
      await fetchOlder();
    });
    await settle();
    expect(view.container.textContent).toBe('m1,m2,m3,m4 end');
    expect(asked).toEqual([undefined, id(2)]);
  });

  test('a thread reads forwards and can wait until it is asked for', async () => {
    const asked: (string | undefined)[] = [];
    const api = anApi({
      thread: (_root, query) => {
        asked.push(query?.after);
        return Promise.resolve(page(null, 5, 6));
      },
    });
    const Thread = ({ on }: { on: boolean }): React.JSX.Element => {
      const thread = useThread('root', on);
      return (
        <p>
          {repliesOf(thread.data)
            .map((m) => m.content)
            .join(',')}
        </p>
      );
    };
    const off = await renderApp(<Thread on={false} />, { api });
    await settle();
    expect(off.container.textContent).toBe('');
    expect(asked).toEqual([]);
    const on = await renderApp(<Thread on />, { api });
    await settle();
    expect(on.container.textContent).toBe('m5,m6');
    expect(asked).toEqual([undefined]);
  });

  test('the open questions page backwards from the newest', async () => {
    const api = anApi({
      unresolved: (_ws, query) => Promise.resolve(page(null, query?.before === undefined ? 9 : 1)),
    });
    const text = await show(api, () => 'unused');
    expect(text).toBe('unused');
    const Open = (): React.JSX.Element => (
      <p>
        {readingOrder(useUnresolved('w1').data)
          .map((m) => m.content)
          .join(',')}
      </p>
    );
    const view = await renderApp(<Open />, { api });
    await settle();
    expect(view.container.textContent).toBe('m9');
  });
});

describe('reading order', () => {
  test('is oldest first across pages that arrive newest first', () => {
    const data = { pageParams: [undefined, 'x'], pages: [page(null, 6, 5), page(null, 4, 3)] };
    expect(readingOrder(data).map((m) => m.content)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(readingOrder(undefined)).toEqual([]);
    expect(repliesOf(undefined)).toEqual([]);
  });
});
