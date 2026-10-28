/**
 * A read position the server did not take is not forgotten: tried once more, and — when the
 * person has left or the retry fails too — owed to the next time the channel is opened.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { useState } from 'react';
import type { ReadChannelResponse } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { fakeSchedule } from '../../testing/fakes';
import { IDS, aSignedInApi, messageIdAt } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import type { FeedPorts } from './feed-ports';
import { READ_DEBOUNCE_MS, READ_RETRY_MS, useMarkRead } from './use-mark-read';

installDom();

const read = (id: string): ReadChannelResponse => ({
  lastReadMessageId: id,
  unreadCount: 0,
  unreadMentionCount: 0,
});

const NEWEST = messageIdAt(5);

const mount = async (
  answers: (call: number) => Promise<ReadChannelResponse>,
): Promise<{
  readonly calls: string[];
  readonly advance: (ms: number) => Promise<void>;
  readonly show: (on: boolean) => Promise<void>;
  readonly foreground: (on: boolean) => Promise<void>;
}> => {
  const timers = fakeSchedule();
  const calls: string[] = [];
  let foreground = true;
  const visibility = new Set<() => void>();
  const ports: FeedPorts = {
    whenVisible: () => () => undefined,
    whenResized: () => () => undefined,
    pageVisible: () => foreground,
    onPageVisibility: (listener) => {
      visibility.add(listener);
      return (): void => {
        visibility.delete(listener);
      };
    },
    schedule: timers.schedule,
    clock: { now: () => new Date(0) },
  };
  let set: (on: boolean) => void = () => undefined;
  const Probe = (): null => {
    useMarkRead({
      channelId: IDS.api,
      member: true,
      readAtOpen: null,
      newestId: NEWEST,
      atBottom: true,
      ports,
    });
    return null;
  };
  const Host = (): React.JSX.Element | null => {
    const [on, setOn] = useState(true);
    set = setOn;
    return on ? <Probe /> : null;
  };
  await renderApp(<Host />, {
    api: aSignedInApi({
      markRead: (_channel, id) => {
        calls.push(id);
        return answers(calls.length);
      },
    }),
  });
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  };
  return {
    calls,
    foreground: async (on): Promise<void> => {
      await act(async () => {
        foreground = on;
        for (const listener of visibility) listener();
        await flush();
      });
    },
    advance: async (ms): Promise<void> => {
      await act(async () => {
        timers.advance(ms);
        await flush();
      });
    },
    show: async (on): Promise<void> => {
      await act(async () => {
        set(on);
        await flush();
      });
    },
  };
};

const down = (): Promise<ReadChannelResponse> =>
  Promise.reject(new ApiError(0, 'NETWORK', 'offline'));

describe('a read position the server did not take', () => {
  test('losing focus cancels a pending read until the person returns', async () => {
    const m = await mount(() => Promise.resolve(read(NEWEST)));
    await m.advance(READ_DEBOUNCE_MS - 1);
    await m.foreground(false);
    await m.advance(READ_DEBOUNCE_MS * 2);
    expect(m.calls).toEqual([]);
    await m.foreground(true);
    await m.advance(READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([NEWEST]);
  });

  test('is sent again once, after a pause, and not in a loop', async () => {
    const m = await mount((call) => (call < 2 ? down() : Promise.resolve(read(NEWEST))));
    await m.advance(READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([NEWEST]);
    await m.advance(READ_RETRY_MS);
    expect(m.calls).toEqual([NEWEST, NEWEST]);
    await m.advance(READ_RETRY_MS * 10);
    expect(m.calls).toEqual([NEWEST, NEWEST]);
  });

  test('that fails twice is not tried a third time while the channel stays open', async () => {
    const m = await mount(() => down());
    await m.advance(READ_DEBOUNCE_MS);
    await m.advance(READ_RETRY_MS);
    await m.advance(READ_RETRY_MS * 10);
    expect(m.calls).toEqual([NEWEST, NEWEST]);
  });

  test('that failed on the way out is sent the next time the channel is opened', async () => {
    const m = await mount((call) => (call === 1 ? down() : Promise.resolve(read(NEWEST))));
    // Left before the pause was over: the leave-time send is the first call, and it fails.
    await m.show(false);
    expect(m.calls).toEqual([NEWEST]);
    await m.advance(READ_RETRY_MS * 4);
    expect(m.calls).toEqual([NEWEST]); // nobody is there to retry
    await m.show(true);
    expect(m.calls).toEqual([NEWEST, NEWEST]);
  });
});
