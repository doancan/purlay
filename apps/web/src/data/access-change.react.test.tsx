/** A fresh authorized channel list may wait without turning a retained guest send into access loss. */
import { expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, Message } from '@purlay/types';
import { installDom } from '../testing/dom';
import { mountChannel, page, settle } from '../testing/channel-harness';
import { IDS, aMessage, aSession, someChannels } from '../testing/fixtures';
import { workspaceAccessChanged } from './access-change';
import { keys } from './keys';

installDom();

test('a held channel-list refresh preserves a real guest provider pending send without a lost-message notice', async () => {
  const channels = someChannels().filter((channel) => channel.id === IDS.api);
  const fresh = Promise.withResolvers<Channel[]>();
  const sent = Promise.withResolvers<Message>();
  let blocked = false;
  let id = '';
  const session = aSession();
  session.memberships = session.memberships.map((membership) => ({
    ...membership,
    role: 'member' as const,
    access: { kind: 'guest' as const, historySince: '2026-09-01T00:00:00.000Z', expiresAt: null },
  }));
  const view = await mountChannel({
    messages: page([]),
    api: {
      me: () => Promise.resolve(session),
      channels: () => (blocked ? fresh.promise : Promise.resolve(channels)),
      send: () => sent.promise,
    },
  });
  const retainedEngine = view.engine();
  try {
    act(() => {
      id = view.engine().send({ channelId: IDS.api, content: 'Retain this pending guest send' });
    });
    expect(
      view
        .engine()
        .store.getState()
        .pending.some((row) => row.id === id),
    ).toBe(true);
    blocked = true;
    act(() => {
      workspaceAccessChanged(view.world.client, IDS.workspace);
    });
    await settle();
    expect(view.world.client.getQueryData(keys.channels(IDS.workspace)) === undefined).toBe(true);
    expect(view.engine() === retainedEngine).toBe(true);
    expect(
      view
        .engine()
        .store.getState()
        .pending.find((row) => row.id === id)?.delivery,
    ).toBe('sending');
    expect(
      view
        .engine()
        .store.getState()
        .pending.some((row) => row.id === id),
    ).toBe(true);
    expect(view.engine().store.getState().lost === null).toBe(true);
    fresh.resolve(channels);
    await settle();
    expect(
      view
        .engine()
        .store.getState()
        .pending.some((row) => row.id === id),
    ).toBe(true);
    expect(view.engine().store.getState().lost === null).toBe(true);
  } finally {
    fresh.resolve(channels);
    sent.resolve(aMessage(99, { id, content: 'Retain this pending guest send' }));
    await settle();
    view.unmountAll();
  }
});
