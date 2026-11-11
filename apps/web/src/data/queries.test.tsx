/**
 * The hooks screens read through, over an `Api` the test wrote: each asks the one call
 * it should, with the cursor the previous page named, and none ever reaches an endpoint
 * it should not (the fake refuses).
 */
import {
  NO_PROFILE,
  aSession,
  aMessage,
  aChannel,
  someMembers,
  BOB,
  IDS,
} from '../testing/fixtures';
import { keys } from './keys';
import { captureAccess, watchAccessChanges } from './access-revision';
import { isClaimedBy } from './browser-storage';
import { draftKey, readDraft, writeDraft } from '../features/chat/composer/drafts';
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, Message, MessagePage } from '@purlay/types';
import { installDom } from '../testing/dom';
import { anApi } from '../testing/fake-api';
import { renderApp } from '../testing/render';
import {
  readingOrder,
  repliesOf,
  useChannels,
  useCodeRepository,
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
  githubEvent: null,
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
  test.each(['list', 'repository'] as const)(
    'a late %s subscription observes a module closed after render and resumes when reopened',
    async (reader) => {
      const initial = aSession();
      let reads = 0;
      let closeInLayout = true;
      const List = (): React.JSX.Element => {
        const channels = useChannels(IDS.workspace);
        return <p>{channels.data?.[0]?.name ?? 'no list'}</p>;
      };
      const Repository = (): React.JSX.Element => (
        <p>{useCodeRepository(IDS.workspace, IDS.api) ?? 'no repository'}</p>
      );
      const Reader = reader === 'list' ? List : Repository;
      const Receipt = (): React.JSX.Element => {
        const me = useMe().data;
        const client = useQueryClient();
        useLayoutEffect(() => {
          if (me === undefined || !closeInLayout) return;
          closeInLayout = false;
          client.setQueryData(keys.me, { ...me, modules: [] });
        }, [client, me]);
        return me === undefined ? (
          <p>loading</p>
        ) : (
          <>
            <p>{me.modules.includes('chat') ? 'chat enabled' : 'chat disabled'}</p>
            <Reader />
          </>
        );
      };
      const view = await renderApp(<Receipt />, {
        api: anApi({
          me: () => Promise.resolve(initial),
          channels: () => {
            reads++;
            return Promise.resolve([
              aChannel(IDS.api, 'current channel', { codeRepository: 'owner/current' }),
            ]);
          },
        }),
      });
      try {
        await view.findByText('chat disabled');
        expect(reads).toBe(0);
        act(() => {
          view.world.client.setQueryData(keys.me, initial);
        });
        await view.findByText(reader === 'list' ? 'current channel' : 'owner/current');
        expect(reads).toBe(1);
      } finally {
        view.unmount();
        view.world.client.clear();
      }
    },
  );

  test('access observers see the committed module receipt and ignore a manual cache update during its fetch', async () => {
    const initial = aSession();
    const next = Promise.withResolvers<ReturnType<typeof aSession>>();
    let reads = 0;
    const view = await renderApp(<Probe read={() => useMe().data?.user.username ?? 'loading'} />, {
      api: anApi({
        me: () => {
          reads++;
          return reads === 1 ? Promise.resolve(initial) : next.promise;
        },
      }),
    });
    await view.findByText(initial.user.username);
    const key = keys.message(id(91));
    view.world.client.setQueryData(key, aMessage(91));
    const seen: string[][] = [];
    const stop = watchAccessChanges(view.world.client, () => {
      seen.push([
        ...(view.world.client.getQueryData<ReturnType<typeof aSession>>(keys.me)?.modules ?? []),
      ]);
    });
    try {
      await act(async () => {
        const refresh = view.world.client.refetchQueries({ queryKey: keys.me, exact: true });
        next.resolve({ ...initial, modules: [] });
        await Promise.resolve();
        view.world.client.setQueryData(keys.me, { ...initial, awayChosen: true });
        await refresh;
      });
      expect(seen).toEqual([[]]);
      expect(view.world.client.getQueryData(key) === undefined).toBe(true);
    } finally {
      next.resolve(initial);
      stop();
      view.unmount();
      view.world.client.clear();
    }
  });

  test('a cancelled prior account response cannot clear fresh content or drafts belonging to the current account', async () => {
    const initial = aSession();
    const next = Promise.withResolvers<ReturnType<typeof aSession>>();
    let reads = 0;
    const bob = { ...initial, user: { ...initial.user, ...BOB, email: 'bob@example.test' } };
    const view = await renderApp(<Probe read={() => useMe().data?.user.username ?? 'loading'} />, {
      api: anApi({
        me: () => {
          reads++;
          return reads === 1
            ? Promise.resolve(initial)
            : reads === 2
              ? next.promise
              : Promise.resolve(bob);
        },
      }),
    });
    try {
      await view.findByText(initial.user.username);
      const oldRead = view.world.client.refetchQueries({ queryKey: keys.me, exact: true });
      await view.world.client.cancelQueries({ queryKey: keys.me, exact: true });
      await act(async () => {
        await view.world.client.refetchQueries({ queryKey: keys.me, exact: true });
      });
      await view.findByText(BOB.username);
      const current = aMessage(92, { sender: BOB, content: 'Fresh current account content' });
      view.world.client.setQueryData(keys.message(current.id), current);
      const draft = draftKey(BOB.id, IDS.api, undefined);
      writeDraft(view.world.storage, draft, 'Current account unfinished message');
      expect(isClaimedBy(view.world.storage, BOB.id)).toBe(true);
      next.resolve(initial);
      await oldRead;
      await settle();
      expect(view.world.client.getQueryData<ReturnType<typeof aSession>>(keys.me)?.user.id).toBe(
        BOB.id,
      );
      expect(view.world.client.getQueryData<Message>(keys.message(current.id))?.content).toBe(
        current.content,
      );
      expect(isClaimedBy(view.world.storage, BOB.id)).toBe(true);
      expect(readDraft(view.world.storage, draft)).toBe('Current account unfinished message');
    } finally {
      next.resolve(initial);
      view.unmount();
      view.world.client.clear();
    }
  });

  test('a fresh guest admission cannot reuse the former full channel names or workspace directory', async () => {
    const initial = aSession();
    const base = initial.memberships[0];
    if (base === undefined) throw new Error('Missing membership fixture');
    const other = {
      ...base,
      workspace: {
        ...base.workspace,
        id: '00000000-0000-4000-8000-0000000000bb',
        slug: 'other',
        name: 'Other',
      },
    };
    initial.memberships = [base, other];
    let served = initial;
    const view = await renderApp(<Probe read={() => useMe().data?.user.username ?? 'loading'} />, {
      api: anApi({ me: () => Promise.resolve(served) }),
    });
    try {
      await view.findByText(initial.user.username);
      const oldChannels = [aChannel(IDS.api, 'Finance private', { type: 'private' })];
      const oldMembers = someMembers();
      view.world.client.setQueryData(keys.channels(IDS.workspace), oldChannels);
      view.world.client.setQueryData(keys.members(IDS.workspace), oldMembers);
      view.world.client.setQueryData(keys.channels(other.workspace.id), []);
      view.world.client.setQueryData(keys.members(other.workspace.id), oldMembers);
      served = {
        ...initial,
        memberships: [
          {
            ...base,
            role: 'member',
            access: { kind: 'guest', historySince: '2026-11-10T12:00:00.000Z', expiresAt: null },
          },
          other,
        ],
      };
      await act(async () => {
        await view.world.client.invalidateQueries({ queryKey: keys.me, exact: true });
      });
      expect(view.world.client.getQueryData(keys.channels(IDS.workspace)) === undefined).toBe(true);
      expect(view.world.client.getQueryData(keys.members(IDS.workspace)) === undefined).toBe(true);
      expect(view.world.client.getQueryData(keys.channels(other.workspace.id))).toEqual([]);
      expect(view.world.client.getQueryData(keys.members(other.workspace.id))).toEqual(oldMembers);
    } finally {
      view.unmount();
      view.world.client.clear();
    }
  });

  test('an actual account switch invalidates old content work before the new identity is published', async () => {
    let served = aSession();
    const view = await renderApp(<Probe read={() => useMe().data?.user.username ?? 'loading'} />, {
      api: anApi({ me: () => Promise.resolve(served) }),
    });
    await view.findByText(served.user.username);
    const key = keys.pins(IDS.api);
    view.world.client.setQueryData(keys.quietHours, { quietHours: null, timeZone: null });
    view.world.client.setQueryData(keys.missedMail, { on: true, available: true });
    view.world.client.setQueryData(key, []);
    const old = captureAccess(view.world.client, key);
    const seen: boolean[] = [];
    const stop = watchAccessChanges(view.world.client, () => {
      seen.push(old());
    });
    try {
      served = {
        ...served,
        user: { ...served.user, ...BOB, email: 'bob@example.test' },
        memberships: [],
      };
      await act(async () => {
        await view.world.client.invalidateQueries({ queryKey: keys.me, exact: true });
      });
      await view.findByText(BOB.username);
      expect(old()).toBe(false);
      expect(seen).toEqual([false]);
      expect(view.world.client.getQueryData(key) === undefined).toBe(true);
      expect(view.world.client.getQueryData(keys.quietHours) === undefined).toBe(true);
      expect(view.world.client.getQueryData(keys.missedMail) === undefined).toBe(true);
    } finally {
      stop();
      view.unmount();
      view.world.client.clear();
    }
  });

  test.each([
    'removed',
    'readmitted',
    'converted',
    'extended',
    'chat-disabled',
    'stable',
    'legacy-member',
  ] as const)(
    'a current %s receipt handles prior cached content before publishing the new membership',
    async (change) => {
      const initial = aSession();
      const oldFloor = '2026-11-01T12:00:00.000Z';
      const newFloor = '2026-11-10T12:00:00.000Z';
      initial.memberships = initial.memberships.map((membership) =>
        change === 'legacy-member'
          ? membership
          : {
              ...membership,
              role: 'member' as const,
              access: { kind: 'guest' as const, historySince: oldFloor, expiresAt: null },
            },
      );
      let served = initial;
      const read = (): string => {
        const current = useMe().data;
        return current === undefined
          ? 'loading'
          : current.memberships[0]?.access?.kind === 'guest'
            ? current.memberships[0].access.historySince
            : 'member-or-absent';
      };
      const view = await renderApp(<Probe read={read} />, {
        api: anApi({ me: () => Promise.resolve(served) }),
      });
      try {
        await view.findByText(change === 'legacy-member' ? 'member-or-absent' : oldFloor);
        view.world.client.setQueryData(
          keys.message(id(88)),
          aMessage(88, { content: 'Earlier admission' }),
        );
        served = {
          ...initial,
          memberships: initial.memberships.flatMap((membership) =>
            change === 'removed'
              ? []
              : [
                  {
                    ...membership,
                    ...(change === 'readmitted'
                      ? {
                          access: {
                            kind: 'guest' as const,
                            historySince: newFloor,
                            expiresAt: null,
                          },
                        }
                      : {}),
                    ...(change === 'converted' || change === 'legacy-member'
                      ? { access: { kind: 'member' as const } }
                      : {}),
                    ...(change === 'extended'
                      ? {
                          access: {
                            kind: 'guest' as const,
                            historySince: oldFloor,
                            expiresAt: '2026-12-01T12:00:00.000Z',
                          },
                        }
                      : {}),
                    ...(change === 'chat-disabled' ? { modules: [] } : {}),
                  },
                ],
          ),
        };
        await act(async () => {
          await view.world.client.invalidateQueries({ queryKey: keys.me, exact: true });
        });
        expect(view.world.client.getQueryData(keys.message(id(88))) === undefined).toBe(
          change !== 'stable' && change !== 'legacy-member',
        );
        expect(view.world.client.getQueryData(keys.me)).toEqual(served);
      } finally {
        view.unmount();
        view.world.client.clear();
      }
    },
  );

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
          mayCreateWorkspace: true,
          isServerAdmin: false,
          nameFromGitHub: false,
          mustEnrolTwoFactor: false,
          scheduledDeletions: [],
          modules: ['chat'],
          awayChosen: false,
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
