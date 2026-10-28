/**
 * Notifications (D-12, D-15, D-107, D-146), through the real frame at the page's address: what
 * interrupts, said in words; Deep Work started and ended here; and each joined channel's level,
 * painted at once and put back, said, when the server refuses it. The device's switch is
 * `push/push.test.tsx`'s.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { Channel, NotificationLevel, SetDeepWorkRequest } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { ALICE, IDS, aChannel, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** Three joined channels, out of order; one public channel not joined; one direct message. */
const channels = (): Channel[] => [
  aChannel(IDS.incidents, 'incidents', { notificationLevel: 'all' }),
  aChannel(IDS.api, 'api'),
  aChannel(IDS.deploys, 'deploys', { notificationLevel: 'none' }),
  aChannel(IDS.browse, 'browse', { state: null, notificationLevel: null }),
  aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE }),
];

const open = async (api: Partial<Api> = {}): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path: '/w/acme/settings/notifications',
      api: aSignedInApi({ channels: () => Promise.resolve(channels()), ...api }),
    },
  );
  await settle();
  await view.findByRole('heading', { level: 1, name: 'Notifications' });
  await settle();
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));
const levelOf = (view: View, channel: string): HTMLSelectElement =>
  main(view).getByRole('combobox', { name: `Notifications for #${channel}` });

describe('notifications', () => {
  test('say what interrupts, in words', async () => {
    const view = await open();
    const card = within(view.getByRole('region', { name: 'What interrupts you' }));
    expect(card.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Somebody mentions you with @',
      'Somebody writes to you directly',
      'Somebody replies in a thread you started or replied in',
      'Somebody writes in a channel you set to Every message',
    ]);
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('list each channel the person is in, by name, with its level — and no other', async () => {
    const view = await open();
    const card = within(view.getByRole('region', { name: 'Channels' }));
    expect(
      card
        .getAllByRole('combobox')
        .map((select) => [select.getAttribute('aria-label'), (select as HTMLSelectElement).value]),
    ).toEqual([
      ['Notifications for #api', 'mentions'],
      ['Notifications for #deploys', 'none'],
      ['Notifications for #incidents', 'all'],
    ]);
    expect([...levelOf(view, 'api').options].map((option) => option.textContent)).toEqual([
      'Every message',
      'Mentions and replies',
      'Nothing',
    ]);
    view.unmount();
  });

  test('a level chosen is painted at once and sent', async () => {
    const sent: [string, NotificationLevel][] = [];
    const view = await open({
      setNotificationLevel: (channelId, level) => {
        sent.push([channelId, level]);
        return new Promise(() => undefined);
      },
    });
    await person().selectOptions(levelOf(view, 'api'), 'all');
    expect(levelOf(view, 'api').value).toBe('all');
    expect(sent).toEqual([[IDS.api, 'all']]);
    view.unmount();
  });

  test('a level the server refuses is put back, and said', async () => {
    const view = await open({
      setNotificationLevel: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    await person().selectOptions(levelOf(view, 'deploys'), 'mentions');
    await settle();
    expect(levelOf(view, 'deploys').value).toBe('none');
    expect(view.getByText(/^The notification level was not changed\./)).toBeDefined();
    view.unmount();
  });

  test('channels that could not be read say why, and Retry reads them again', async () => {
    let reads = 0;
    const view = await open({
      channels: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'x'))
          : Promise.resolve(channels());
      },
    });
    const card = within(view.getByRole('region', { name: 'Channels' }));
    expect(card.queryAllByRole('combobox')).toEqual([]);
    const retry = card.getByRole('button', { name: 'Retry' });
    expect(retry.previousElementSibling?.textContent).not.toBe('');
    await person().click(retry);
    await settle();
    expect(card.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(card.getAllByRole('combobox')).toHaveLength(3);
    view.unmount();
  });

  test('in no channel yet, it says so', async () => {
    const view = await open({ channels: () => Promise.resolve([]) });
    expect(main(view).getByText('You are in no channels yet.')).toBeDefined();
    view.unmount();
  });

  test('Deep Work is started here for a while, as from the account menu', async () => {
    const asked: SetDeepWorkRequest[] = [];
    const view = await open({
      setDeepWork: (_workspace, input) => {
        asked.push(input);
        return new Promise(() => undefined);
      },
    });
    const card = within(view.getByRole('region', { name: 'Deep Work' }));
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'For 30 minutes',
      'For 1 hour',
      'For 2 hours',
      'Until tomorrow',
    ]);
    await person().click(card.getByRole('button', { name: 'For 1 hour' }));
    await settle();
    expect(asked).toEqual([{ active: true, until: expect.any(String) as unknown as string }]);
    expect(card.getByText('Deep Work is on')).toBeDefined();
    expect(card.getByRole('button', { name: 'End Deep Work' })).toBeDefined();
    view.unmount();
  });

  test('where this device cannot be told with Purlay closed, it says so plainly', async () => {
    const view = await open();
    const card = within(view.getByRole('region', { name: 'Notifications on this device' }));
    // A browser with no notices at all says so; one with them says a closed tab hears nothing here.
    expect(
      card.getByText(/cannot show notifications|with Purlay closed you hear nothing/),
    ).toBeDefined();
    // The open tab's notices are still offered (D-148), and say they reach the open tab alone.
    if (card.queryByRole('button') !== null) {
      expect(card.getByText(/while Purlay is open in a background tab/)).toBeDefined();
    }
    view.unmount();
  });
});
