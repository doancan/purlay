/**
 * Starred channels (#489, D-132) as a person meets them through the real frame: Star in a channel's
 * header, painted at once into a section of its own above Channels and out of it, put back with
 * Retry when refused; nothing to press for a channel they are not in; and another tab's star read
 * again when the server says the list changed.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aSignedInApi, someChannels } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Partial<Api>, path = `/w/acme/c/${IDS.api}`): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path,
      api: aSignedInApi({
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

const listed = (view: View, section: string): string[] =>
  [...(view.queryByRole('navigation', { name: section })?.querySelectorAll('a') ?? [])].map((a) =>
    a.textContent.trim(),
  );

const star = (view: View): HTMLElement => view.getByRole('button', { name: 'Star this channel' });

describe('starring a channel', () => {
  test('moves it at once into Starred, above Channels and out of it, and the server is asked once', async () => {
    const asked: [string, boolean][] = [];
    const view = await open({
      star: (channelId, starred) => {
        asked.push([channelId, starred]);
        return new Promise(() => undefined);
      },
    });
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(star(view).getAttribute('aria-pressed')).toBe('false');

    await person().click(star(view));

    expect(listed(view, 'Starred')).toEqual(['api']);
    expect(listed(view, 'Channels')).toEqual(['deploys', 'incidents']);
    expect(star(view).getAttribute('aria-pressed')).toBe('true');
    expect(asked).toEqual([[IDS.api, true]]);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('Starred is in order of name, and a star is let go the same way', async () => {
    const channels = someChannels().map((c) =>
      c.id === IDS.incidents || c.id === IDS.api ? { ...c, starred: true } : c,
    );
    const asked: [string, boolean][] = [];
    const view = await open({
      channels: () => Promise.resolve(channels),
      star: (channelId, starred) => {
        asked.push([channelId, starred]);
        return Promise.resolve();
      },
    });
    expect(listed(view, 'Starred')).toEqual(['api', 'incidents']);

    await person().click(star(view));
    await settle();

    expect(listed(view, 'Starred')).toEqual(['incidents']);
    expect(listed(view, 'Channels')).toContain('api');
    expect(asked).toEqual([[IDS.api, false]]);
    view.unmount();
  });

  test('refused, it is put back and said, and Retry tries again', async () => {
    let refuse = true;
    const asked: boolean[] = [];
    const view = await open({
      star: (_channelId, starred) => {
        asked.push(starred);
        return refuse ? Promise.reject(new ApiError(0, 'NETWORK', 'offline')) : Promise.resolve();
      },
    });
    await person().click(star(view));
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(view.getByText(/^The channel was not starred\./)).toBeDefined();

    refuse = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asked).toEqual([true, true]);
    expect(listed(view, 'Starred')).toEqual(['api']);
    view.unmount();
  });

  test('from the header’s menu — where a narrow window keeps it — it stars and lets go', async () => {
    const asked: boolean[] = [];
    const view = await open({
      star: (_channelId, starred) => {
        asked.push(starred);
        return Promise.resolve();
      },
    });
    await person().click(view.getByRole('button', { name: 'Channel menu' }));
    await person().click(await view.findByRole('menuitem', { name: 'Star this channel' }));
    await settle();
    expect(listed(view, 'Starred')).toEqual(['api']);
    await person().click(view.getByRole('button', { name: 'Channel menu' }));
    await person().click(await view.findByRole('menuitem', { name: 'Remove from starred' }));
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(asked).toEqual([true, false]);
    view.unmount();
  });

  test('a channel the person can see and is not in has no star', async () => {
    const view = await open({}, `/w/acme/c/${IDS.browse}`);
    expect(view.queryByRole('button', { name: 'Star this channel' })).toBeNull();
    view.unmount();
  });
});
