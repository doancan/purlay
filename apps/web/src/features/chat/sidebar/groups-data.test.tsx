/** Multiple failed intents must return to confirmed state, including when refreshing also fails. */
import { expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, ChannelGroup } from '@purlay/types';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import { aChannel, aSignedInApi, IDS } from '../../../testing/fixtures';
import { SessionGate } from '../../session/session';
import { WorkspaceScopeProvider } from '../../shell/workspace';
import { useChannelGroups } from './groups-data';
import { useGroupActions } from './group-actions';
import { keys } from '../../../data/keys';
import { aSession, BOB } from '../../../testing/fixtures';
import { useStar } from '../channel/star-toggle';
import { useChannels } from '../../../data/queries';
import { ApiError } from '../../../data/errors';

installDom();

test('a refused star followed by a refused move restores the original group without replacing newer unread counters', async () => {
  const first = Promise.withResolvers<undefined>();
  const second = Promise.withResolvers<Channel>();
  const original = aChannel(IDS.api, 'Operations', {
    sidebarGroupId: '00000000-0000-4000-8000-0000000000f1',
  });
  let reads = 0;
  let actions: ReturnType<typeof useGroupActions> | null = null;
  let star: ReturnType<typeof useStar> = null;
  const Probe = (): React.JSX.Element => {
    actions = useGroupActions();
    const channels = useChannels(IDS.workspace);
    star = useStar(channels.data?.[0]);
    return <output aria-label="group">{channels.data?.[0]?.sidebarGroupId ?? ''}</output>;
  };
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={<p>missing</p>}>
        <Probe />
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      api: aSignedInApi({
        channels: () =>
          ++reads === 1 ? Promise.resolve([original]) : Promise.reject(new Error('offline')),
        star: async () => {
          await first.promise;
        },
        moveChannelGroup: async () => await second.promise,
      }),
    },
  );
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  let move = Promise.resolve();
  await act(async () => {
    if (star === null || actions === null) throw new Error('actions missing');
    star(true);
    move = actions.move(original, '00000000-0000-4000-8000-0000000000f2').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(view.getByLabelText('group').textContent).toBe('00000000-0000-4000-8000-0000000000f2');
  await act(async () => {
    view.world.client.setQueryData<Channel[]>(keys.channels(IDS.workspace), (before) =>
      before?.map((channel) => ({
        ...channel,
        name: 'Renamed elsewhere',
        state: { lastReadMessageId: null, unreadCount: 4, unreadMentionCount: 1 },
      })),
    );
    first.reject(new ApiError(0, 'NETWORK', 'offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    second.reject(new ApiError(0, 'NETWORK', 'offline'));
    await move;
  });
  expect(
    view.world.client.getQueryData<Channel[]>(keys.channels(IDS.workspace))?.[0],
  ).toMatchObject({
    sidebarGroupId: original.sidebarGroupId,
    starred: false,
    name: 'Renamed elsewhere',
    state: { unreadCount: 4, unreadMentionCount: 1 },
  });
});

test('two refused changes do not leave a group that was never saved when the refresh is offline', async () => {
  const one = Promise.withResolvers<ChannelGroup>();
  const two = Promise.withResolvers<ChannelGroup>();
  let reads = 0;
  let writes = 0;
  let actions: ReturnType<typeof useGroupActions> | null = null;
  const Probe = (): React.JSX.Element => {
    actions = useGroupActions();
    const groups = useChannelGroups();
    return (
      <output aria-label="headings">
        {groups.data?.data.map((group) => group.name).join(',')}
      </output>
    );
  };
  const current = (): ReturnType<typeof useGroupActions> => {
    if (actions === null) throw new Error('actions not rendered');
    return actions;
  };
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={<p>missing</p>}>
        <Probe />
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      path: '/w/acme',
      api: aSignedInApi({
        channelGroups: () => {
          if (reads++ === 0) return Promise.resolve({ data: [], nextCursor: null });
          return Promise.reject(new Error('offline'));
        },
        saveChannelGroup: async () => await (++writes === 1 ? one.promise : two.promise),
      }),
    },
  );
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 4; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };
  await settle();
  const id = '00000000-0000-4000-8000-0000000000f1';
  let first = Promise.resolve();
  let second = Promise.resolve();
  await act(async () => {
    first = current()
      .save(id, 'First')
      .catch(() => undefined);
    second = current()
      .save(id, 'Second')
      .catch(() => undefined);

    await Promise.resolve();
  });
  await settle();
  expect(view.getByLabelText('headings').textContent).toBe('Second');
  await act(async () => {
    one.reject(new Error('offline'));
    await first;
  });
  await act(async () => {
    two.reject(new Error('offline'));
    await second;
  });
  await settle();
  expect(view.getByLabelText('headings').textContent).toBe('');
});

test('an old account’s queued write is not sent and its late answer cannot populate the new account’s cache', async () => {
  const held = Promise.withResolvers<ChannelGroup>();
  let writes = 0;
  let actions: ReturnType<typeof useGroupActions> | null = null;
  const Probe = (): React.JSX.Element => {
    actions = useGroupActions();
    useChannelGroups();
    return <p>ready</p>;
  };
  const current = (): ReturnType<typeof useGroupActions> => {
    if (actions === null) throw new Error('actions not rendered');
    return actions;
  };
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={<p>missing</p>}>
        <Probe />
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      api: aSignedInApi({
        saveChannelGroup: async () => {
          writes += 1;
          return await held.promise;
        },
      }),
    },
  );
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const groupId = '00000000-0000-4000-8000-0000000000f1';
  let first = Promise.resolve();
  let second = Promise.resolve();
  await act(async () => {
    const original = current();
    first = original.save(groupId, 'Private').catch(() => undefined);
    second = original.save(groupId, 'Still private').catch(() => undefined);

    await Promise.resolve();
  });
  await act(async () => {
    view.world.client.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    view.world.client.setQueryData(keys.me, {
      ...aSession(),
      user: { ...BOB, email: 'bob@example.test' },
      memberships: [],
    });

    await Promise.resolve();
  });
  await act(async () => {
    held.resolve({ id: groupId, name: 'Private', collapsed: false });
    await Promise.all([first, second]);
  });
  expect(writes).toBe(1);
  expect(
    view.world.client.getQueryData(
      keys.channelGroups(aSession().memberships[0]?.workspace.id ?? ''),
    ),
  ).toBeUndefined();
});
