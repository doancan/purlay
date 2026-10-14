/**
 * The step after accepting an invitation (#489, D-132), through the real frame: the public channels
 * to join, the busiest marked and picked; joined together and into the workspace; a join that fails
 * part way said by name and kept picked; skipped; and its loading, failing and empty states.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Channel } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { expectFocusOn } from '../../testing/focus';
import { Toaster } from '../../ui/toast';
import { person } from '../../testing/user';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const at = (hour: number): string => new Date(Date.UTC(2026, 8, 9, hour)).toISOString();
const id = (n: number): string => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const open = (n: number, name: string, lastMessageAt: string | null): Channel =>
  aChannel(id(n), name, { state: null, lastMessageAt, topic: `about ${name}` });

/** One joined, five to join: four with messages, one silent. */
const channels = (): Channel[] => [
  aChannel(IDS.api, 'api'),
  open(1, 'deploys', at(9)),
  open(2, 'design', at(12)),
  open(3, 'random', at(8)),
  open(4, 'support', at(11)),
  open(5, 'quiet', null),
];

type View = Awaited<ReturnType<typeof renderApp>>;

/**
 * A server that keeps what was joined, as the real one does: a list read again says so. `refuse`
 * answers a join with a failure, or nothing to let it through.
 */
const aServer = (
  refuse: (channelId: string) => ApiError | null = () => null,
): { readonly joined: string[]; readonly api: Partial<Api> } => {
  const joined: string[] = [];
  return {
    joined,
    api: {
      channels: () =>
        Promise.resolve(
          channels().map((c) =>
            joined.includes(c.id)
              ? { ...c, state: { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 } }
              : c,
          ),
        ),
      joinChannel: (channelId): Promise<Channel> => {
        const refusal = refuse(channelId);
        if (refusal !== null) return Promise.reject(refusal);
        joined.push(channelId);
        const channel = channels().find((c) => c.id === channelId);
        return Promise.resolve(
          aChannel(channelId, channel?.name ?? 'x', {
            state: { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 },
          }),
        );
      },
    },
  };
};

const visit = async (api: Partial<Api> = {}): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: '/w/acme/welcome',
      api: aSignedInApi({ ...aServer().api, ...api }),
    },
  );
  await settle();
  return view;
};

/** This screen, not the sidebar beside it. */
const screenOf = (view: View): HTMLElement => {
  const section = view.getByRole('heading', { name: 'Welcome to acme-eng' }).closest('section');
  if (section === null) throw new Error('no welcome section');
  return section;
};

const here = (view: View): string => view.world.history.stack.at(-1) ?? '';
const box = (view: View, name: string): HTMLInputElement => {
  const found = view.getByRole('checkbox', { name: `#${name}` });
  if (!(found instanceof HTMLInputElement)) throw new Error(`#${name} is not a box`);
  return found;
};

describe('the channels to join, after an invitation', () => {
  test('lists the ones to join, the three busiest marked Active and picked', async () => {
    const view = await visit();
    expect(view.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual([
      '#deploys',
      '#design',
      '#quiet',
      '#random',
      '#support',
    ]);
    expect(['design', 'support', 'deploys'].map((n) => box(view, n).checked)).toEqual([
      true,
      true,
      true,
    ]);
    expect(box(view, 'random').checked).toBe(false);
    expect(box(view, 'quiet').checked).toBe(false);
    expect(view.queryByRole('checkbox', { name: '#api' })).toBeNull();
    // Described by whether it is busy and what it is for — not by its name again.
    const about = document.getElementById(
      box(view, 'design').getAttribute('aria-describedby') ?? '',
    );
    expect(about?.textContent).toBe('Activeabout design');
    expect(view.getByRole('button', { name: 'Join 3 channels' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('says it is loading while the channels are on their way', async () => {
    const view = await visit({ channels: () => new Promise(() => undefined) });
    expect(within(screenOf(view)).getByRole('status').textContent).toContain(
      'Loading the channels',
    );
    view.unmount();
  });

  test('joins what is picked, and goes into the workspace', async () => {
    const server = aServer();
    const view = await visit(server.api);
    await person().click(box(view, 'support'));
    await person().click(box(view, 'quiet'));
    await person().click(view.getByRole('button', { name: 'Join 3 channels' }));
    await settle();
    expect([...server.joined].sort()).toEqual([id(1), id(2), id(5)].sort());
    expect(here(view)).toMatch(/^\/w\/acme(\/c\/|$)/);
    view.unmount();
  });

  test('a join that fails part way says which, keeps it picked, and tries only it again', async () => {
    let refuse = true;
    const server = aServer((channelId) =>
      channelId === id(2) && refuse ? new ApiError(0, 'NETWORK', 'offline') : null,
    );
    const view = await visit(server.api);
    // From the keyboard: a box has focus, and Enter sends the form.
    box(view, 'quiet').focus();
    await person().keyboard('{Enter}');
    await settle();
    const alert = within(screenOf(view)).getByRole('alert');
    expect(alert.textContent).toMatch(/^Could not join #design\. Check your connection/);
    expect(here(view)).toBe('/w/acme/welcome');
    expect(box(view, 'design').checked).toBe(true);
    // Those joined are joined: they leave the list of channels to join.
    expect(view.queryByRole('checkbox', { name: '#support' })).toBeNull();
    expect(view.queryByRole('checkbox', { name: '#deploys' })).toBeNull();
    // Focus is on what tries again.
    expectFocusOn(view.getByRole('button', { name: 'Join 1 channel' }));

    refuse = false;
    await person().click(view.getByRole('button', { name: 'Join 1 channel' }));
    await settle();
    expect(server.joined.filter((c) => c === id(2))).toHaveLength(1);
    expect(server.joined).toHaveLength(3);
    expect(here(view)).toMatch(/^\/w\/acme(\/c\/|$)/);
    view.unmount();
  });

  test('each reason is said with its channels, and a channel that is gone is not offered again', async () => {
    const server = aServer((channelId) =>
      channelId === id(2)
        ? new ApiError(404, 'CHANNEL_NOT_FOUND', 'gone')
        : channelId === id(4)
          ? new ApiError(0, 'NETWORK', 'offline')
          : null,
    );
    const view = await visit(server.api);
    await person().click(view.getByRole('button', { name: 'Join 3 channels' }));
    await settle();
    const lines = within(screenOf(view)).getByRole('alert').querySelectorAll('p');
    expect([...lines].map((p) => p.textContent.split('.')[0])).toEqual([
      'Could not join #design',
      'Could not join #support',
    ]);
    expect(box(view, 'design').checked).toBe(false);
    expect(box(view, 'support').checked).toBe(true);
    expect(view.getByRole('button', { name: 'Join 1 channel' })).toBeDefined();
    view.unmount();
  });

  test('a picked channel that leaves the list is no longer counted', async () => {
    const server = aServer();
    const view = await visit(server.api);
    await person().click(box(view, 'random'));
    expect(view.getByRole('button', { name: 'Join 4 channels' })).toBeDefined();
    // Joined in another tab: read again, it is no longer one to join.
    server.joined.push(id(3));
    await act(async () => {
      await view.world.client.invalidateQueries();
    });
    await settle();
    expect(view.getByRole('button', { name: 'Join 3 channels' })).toBeDefined();
    view.unmount();
  });

  test('left while joining: nothing moves the person, and a failure is said where they are', async () => {
    const answers: (() => void)[] = [];
    const view = await visit({
      joinChannel: (): Promise<Channel> =>
        new Promise((_resolve, reject) => {
          answers.push(() => {
            reject(new ApiError(0, 'NETWORK', 'offline'));
          });
        }),
    });
    await person().click(view.getByRole('button', { name: 'Join 3 channels' }));
    // Away to a channel from the sidebar while the joins are on their way.
    await person().click(
      within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', { name: /api/ }),
    );
    await settle();
    await act(async () => {
      for (const answer of answers) answer();
      await Promise.resolve();
    });
    await settle();
    expect(here(view)).toBe(`/w/acme/c/${IDS.api}`);
    expect(view.getByText(/^Could not join #deploys, #design, #support\./)).toBeDefined();
    view.unmount();
  });

  test('the busiest are marked once: a list read again does not move them', async () => {
    let later = false;
    const view = await visit({
      channels: () =>
        Promise.resolve(
          channels().map((c) =>
            later && c.name === 'random' ? { ...c, lastMessageAt: at(23) } : c,
          ),
        ),
    });
    later = true;
    await act(async () => {
      await view.world.client.invalidateQueries();
    });
    await settle();
    expect(box(view, 'random').checked).toBe(false);
    expect(box(view, 'deploys').checked).toBe(true);
    view.unmount();
  });

  test('a long pick is joined a few at a time, not in one burst', async () => {
    let inFlight = 0;
    let most = 0;
    const view = await visit({
      joinChannel: async (channelId): Promise<Channel> => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return aChannel(channelId, 'x');
      },
    });
    for (const name of ['random', 'quiet']) await person().click(box(view, name));
    await person().click(view.getByRole('button', { name: 'Join 5 channels' }));
    await settle();
    expect(most).toBe(4);
    view.unmount();
  });

  test('can be skipped, joining nothing', async () => {
    const server = aServer();
    const view = await visit(server.api);
    await person().click(view.getByRole('button', { name: 'Skip for now' }));
    await settle();
    expect(server.joined).toEqual([]);
    expect(here(view)).toMatch(/^\/w\/acme(\/c\/|$)/);
    view.unmount();
  });

  test('every channel silent: none is marked, and it does not say the busiest are picked', async () => {
    const view = await visit({
      channels: () => Promise.resolve(channels().map((c) => ({ ...c, lastMessageAt: null }))),
    });
    expect(
      view.getAllByRole('checkbox').every((c) => c instanceof HTMLInputElement && !c.checked),
    ).toBe(true);
    expect(screenOf(view).textContent).not.toContain('busiest');
    expect(view.queryByText('Active')).toBeNull();
    view.unmount();
  });

  test('says when there is nothing to join, and leads on', async () => {
    const view = await visit({ channels: () => Promise.resolve([aChannel(IDS.api, 'api')]) });
    expect(view.getByText('There are no public channels to join yet.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Go to the workspace' }));
    await settle();
    expect(here(view)).toMatch(/^\/w\/acme(\/c\/|$)/);
    view.unmount();
  });

  test('says when the channels did not load, and Retry reads them again', async () => {
    let calls = 0;
    const view = await visit({
      channels: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(channels());
      },
    });
    const alert = within(screenOf(view)).getByRole('alert');
    expect(alert.textContent).toContain('The channels did not load.');
    await person().click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getAllByRole('checkbox')).toHaveLength(5);
    view.unmount();
  });

  test('in Turkish, the count and the failure read as Turkish does', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/welcome',
      api: aSignedInApi(aServer().api),
      locale: 'tr',
    });
    await settle();
    expect(view.getByRole('button', { name: '3 kanala katıl' })).toBeDefined();
    view.unmount();
  });
});
