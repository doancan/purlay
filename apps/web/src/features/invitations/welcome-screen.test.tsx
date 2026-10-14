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

const visit = async (api: Partial<Api> = {}): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/welcome',
    api: aSignedInApi({ channels: () => Promise.resolve(channels()), ...api }),
  });
  await settle();
  return view;
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
    expect(box(view, 'design').getAttribute('aria-describedby')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Join 3 channels' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('joins what is picked, and goes into the workspace', async () => {
    const joined: string[] = [];
    const view = await visit({
      joinChannel: (channelId) => {
        joined.push(channelId);
        return Promise.resolve(aChannel(channelId, 'x'));
      },
    });
    await person().click(box(view, 'support'));
    await person().click(box(view, 'quiet'));
    await person().click(view.getByRole('button', { name: 'Join 3 channels' }));
    await settle();
    expect(joined.sort()).toEqual([id(1), id(2), id(5)].sort());
    expect(here(view)).toMatch(/^\/w\/acme/);
    expect(here(view)).not.toBe('/w/acme/welcome');
    view.unmount();
  });

  test('a join that fails part way says which, keeps those picked, and tries those again', async () => {
    let refuse = true;
    const joined: string[] = [];
    const view = await visit({
      joinChannel: (channelId) => {
        if (channelId === id(2) && refuse) {
          return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        }
        joined.push(channelId);
        return Promise.resolve(aChannel(channelId, 'x'));
      },
    });
    await person().click(view.getByRole('button', { name: 'Join 3 channels' }));
    await settle();
    expect(
      view.getAllByRole('alert').some((a) => a.textContent.startsWith('Could not join #design. ')),
    ).toBe(true);
    expect(here(view)).toBe('/w/acme/welcome');
    expect(box(view, 'design').checked).toBe(true);
    // Those joined are joined: they leave the list of channels to join.
    expect(view.queryByRole('checkbox', { name: '#support' })).toBeNull();

    refuse = false;
    await person().click(view.getByRole('button', { name: 'Join 1 channel' }));
    await settle();
    expect(joined.filter((c) => c === id(2))).toHaveLength(1);
    expect(here(view)).not.toBe('/w/acme/welcome');
    view.unmount();
  });

  test('can be skipped, joining nothing', async () => {
    const view = await visit({ joinChannel: () => Promise.reject(new Error('not expected')) });
    await person().click(view.getByRole('button', { name: 'Skip for now' }));
    await settle();
    expect(here(view)).not.toBe('/w/acme/welcome');
    view.unmount();
  });

  test('says when there is nothing to join, and leads on', async () => {
    const view = await visit({ channels: () => Promise.resolve([aChannel(IDS.api, 'api')]) });
    expect(view.getByText('There are no public channels to join yet.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Go to the workspace' }));
    await settle();
    expect(here(view)).not.toBe('/w/acme/welcome');
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
    // The sidebar says so too, for its own list: this screen's is the one under its heading.
    const screen = view.getByRole('heading', { name: 'Welcome to acme-eng' }).closest('section');
    if (screen === null) throw new Error('no welcome section');
    const alert = within(screen).getByRole('alert');
    expect(alert.textContent).toContain('The channels did not load.');
    await person().click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getAllByRole('checkbox')).toHaveLength(5);
    view.unmount();
  });
});
