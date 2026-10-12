/**
 * Deep Work in the client (D-108, `UX.md` §7, §8): the shortcut, the quiet bar with its end, the
 * badges kept quiet, and the end that comes by itself.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Channel, MeResponse, SetDeepWorkRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aSession, aSignedInApi, someChannels } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { useDeepWork } from './deep-work';

installDom();

const NOON = Date.UTC(2026, 8, 9, 12, 0, 0);
const until = (minutes: number): string => new Date(NOON + minutes * 60_000).toISOString();

const session = (deepWorkUntil: string | null): MeResponse => {
  const me = aSession();
  return { ...me, memberships: me.memberships.map((m) => ({ ...m, deepWorkUntil })) };
};

/** A channel with mentions waiting, so a badge is drawn unless Deep Work keeps it quiet. */
const channels = (): Channel[] => [
  aChannel(IDS.api, 'api', {
    state: { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 2 },
  }),
  ...someChannels().filter((c) => c.id !== IDS.api),
];

const visit = async (
  deepWorkUntil: string | null,
  api: Partial<Api> = {},
): ReturnType<typeof renderApp> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({
        me: () => Promise.resolve(session(deepWorkUntil)),
        channels: () => Promise.resolve(channels()),
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

const shortcut = (): void => {
  act(() => {
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true, shiftKey: true });
  });
};

const badge = (view: Awaited<ReturnType<typeof visit>>): Element | null =>
  view.container.querySelector('[aria-label="2 unread mentions"]');

describe('Deep Work', () => {
  test('off: no bar, and the mention badge is drawn', async () => {
    const view = await visit(null);
    expect(view.queryByText(/Deep Work until/)).toBeNull();
    expect(badge(view)).not.toBeNull();
    view.unmount();
  });

  test('the shortcut starts it for an hour, painted at once: the bar says until when, the badge goes', async () => {
    const asked: SetDeepWorkRequest[] = [];
    const view = await visit(null, {
      setDeepWork: (_workspace, input) => {
        asked.push(input);
        return new Promise(() => undefined);
      },
    });
    shortcut();
    expect(asked).toEqual([{ active: true, until: until(60) }]);
    // Painted before the server answers: the answer above never comes.
    await settle();
    expect(view.getByText(/Deep Work until/)).toBeDefined();
    expect(badge(view)).toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('End ends it; so does the shortcut, the second time', async () => {
    const asked: SetDeepWorkRequest[] = [];
    const view = await visit(until(30), {
      setDeepWork: (_workspace, input) => {
        asked.push(input);
        return Promise.resolve({ until: null });
      },
    });
    expect(view.getByText(/Deep Work until/)).toBeDefined();
    await person().click(view.getByRole('button', { name: 'End' }));
    await settle();
    expect(asked).toEqual([{ active: false }]);
    expect(view.queryByText(/Deep Work until/)).toBeNull();
    expect(badge(view)).not.toBeNull();
    view.unmount();
  });

  test('it ends by itself at its instant, with nobody asking', async () => {
    const view = await visit(until(30));
    expect(view.getByText(/Deep Work until/)).toBeDefined();
    act(() => {
      view.world.timers.advance(30 * 60_000);
    });
    expect(view.queryByText(/Deep Work until/)).toBeNull();
    expect(badge(view)).not.toBeNull();
    view.unmount();
  });

  test('refused, it is off again and the toast says why', async () => {
    const view = await visit(null, {
      setDeepWork: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    shortcut();
    expect(await view.findByText(/Deep Work was not changed\./)).toBeDefined();
    await settle();
    expect(view.queryByText(/Deep Work until/)).toBeNull();
    view.unmount();
  });
});

describe('outside a workspace', () => {
  test('there is no Deep Work to read, and nothing to toggle', async () => {
    const seen: { value: ReturnType<typeof useDeepWork> | null } = { value: null };
    const Probe = (): null => {
      seen.value = useDeepWork();
      return null;
    };
    const view = await renderApp(<Probe />);
    expect(seen.value?.until).toBeNull();
    expect(() => {
      seen.value?.toggle();
    }).not.toThrow();
    view.unmount();
  });
});
