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

/** A server that keeps what was starred, as the real one does: a list read again says so. */
const aServer = (
  starred: readonly string[] = [],
  refuse: () => boolean = () => false,
): { readonly asked: [string, boolean][]; readonly api: Partial<Api> } => {
  const held = new Set(starred);
  const asked: [string, boolean][] = [];
  return {
    asked,
    api: {
      channels: () =>
        Promise.resolve(someChannels().map((c) => ({ ...c, starred: held.has(c.id) }))),
      star: (channelId, on): Promise<void> => {
        asked.push([channelId, on]);
        if (refuse()) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        if (on) held.add(channelId);
        else held.delete(channelId);
        return Promise.resolve();
      },
    },
  };
};

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
    const server = aServer([IDS.incidents, IDS.api]);
    const view = await open(server.api);
    expect(listed(view, 'Starred')).toEqual(['api', 'incidents']);

    await person().click(star(view));
    await settle();

    expect(listed(view, 'Starred')).toEqual(['incidents']);
    expect(listed(view, 'Channels')).toContain('api');
    expect(server.asked).toEqual([[IDS.api, false]]);
    view.unmount();
  });

  test('a starred channel with an incident open carries its mark there too (D-137)', async () => {
    const channels = someChannels().map((c) =>
      c.id === IDS.deploys
        ? {
            ...c,
            starred: true,
            incident: { severity: 2 as const, status: 'investigating' as const },
          }
        : c,
    );
    const view = await open({ channels: () => Promise.resolve(channels) });
    const row = [...view.getByRole('navigation', { name: 'Starred' }).querySelectorAll('a')].find(
      (a) => a.textContent.includes('deploys'),
    );
    expect(row?.textContent).toContain('Incident, severity 2, Investigating');
    view.unmount();
  });

  test('every channel starred, Channels is not said to be empty', async () => {
    const server = aServer([IDS.api, IDS.deploys, IDS.incidents]);
    const view = await open(server.api);
    expect(listed(view, 'Starred')).toEqual(['api', 'deploys', 'incidents']);
    expect(view.queryByText('No channels yet')).toBeNull();
    view.unmount();
  });

  test('two clicks answered in reverse order: the last click is what stays', async () => {
    const answers: (() => void)[] = [];
    const held = new Set<string>();
    const view = await open({
      channels: () =>
        Promise.resolve(someChannels().map((c) => ({ ...c, starred: held.has(c.id) }))),
      star: (channelId, on) =>
        new Promise<void>((resolve) => {
          answers.push(() => {
            if (on) held.add(channelId);
            else held.delete(channelId);
            resolve();
          });
        }),
    });
    await person().click(star(view));
    await person().click(star(view));
    // The second waits for the first: only one request is out.
    expect(answers).toHaveLength(1);
    await act(async () => {
      answers[0]?.();
      await Promise.resolve();
    });
    await settle();
    expect(answers).toHaveLength(2);
    await act(async () => {
      answers[1]?.();
      await Promise.resolve();
    });
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(star(view).getAttribute('aria-pressed')).toBe('false');
    view.unmount();
  });

  test('refused, it is put back and said, and Retry tries again', async () => {
    let refuse = true;
    const server = aServer([], () => refuse);
    const view = await open(server.api);
    await person().click(star(view));
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(view.getByText(/^The channel was not starred\./)).toBeDefined();

    refuse = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(server.asked.map(([, on]) => on)).toEqual([true, true]);
    expect(listed(view, 'Starred')).toEqual(['api']);
    view.unmount();
  });

  test('once answered, the server’s list is the one that stays', async () => {
    // The server took the request and holds no star: let go meanwhile from another device.
    const view = await open({
      channels: () => Promise.resolve(someChannels()),
      star: () => Promise.resolve(),
    });
    await person().click(star(view));
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    view.unmount();
  });

  test('a Retry for what is already so asks nothing', async () => {
    let refuse = true;
    const server = aServer([], () => refuse);
    const view = await open(server.api);
    await person().click(star(view));
    await settle();
    refuse = false;
    await person().click(star(view));
    await settle();
    expect(listed(view, 'Starred')).toEqual(['api']);
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(server.asked.map(([, on]) => on)).toEqual([true, true]);
    view.unmount();
  });

  test('a star refused for good is said, with no Retry', async () => {
    const view = await open({
      star: () => Promise.reject(new ApiError(404, 'CHANNEL_NOT_FOUND', 'gone')),
    });
    await person().click(star(view));
    await settle();
    expect(view.getByText(/^The channel was not starred\./)).toBeDefined();
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    view.unmount();
  });

  test('from the header’s menu — where a narrow window keeps it — it stars and lets go', async () => {
    const server = aServer();
    const view = await open(server.api);
    await person().click(view.getByRole('button', { name: 'Channel menu' }));
    await person().click(await view.findByRole('menuitem', { name: 'Star this channel' }));
    await settle();
    expect(listed(view, 'Starred')).toEqual(['api']);
    await person().click(view.getByRole('button', { name: 'Channel menu' }));
    await person().click(await view.findByRole('menuitem', { name: 'Remove from starred' }));
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(server.asked.map(([, on]) => on)).toEqual([true, false]);
    view.unmount();
  });

  test('the star is beside the channel’s name, not in the cluster of actions on the right', async () => {
    const view = await open(aServer().api);
    const title = view.container.querySelector('[data-header-title]');
    expect(title?.contains(star(view))).toBe(true);
    view.unmount();
  });

  test('a channel the person can see and is not in has no star', async () => {
    const view = await open({}, `/w/acme/c/${IDS.browse}`);
    expect(view.queryByRole('button', { name: 'Star this channel' })).toBeNull();
    view.unmount();
  });
});
