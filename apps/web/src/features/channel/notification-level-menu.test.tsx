/**
 * The channel's notification level, from its header (D-107): for a member only, painted before the
 * server answers, put back when it refuses, and said in both languages.
 */
import { describe, expect, test } from 'bun:test';
import type { NotificationLevel } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, someChannels } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const asked: [string, NotificationLevel][] = [];

describe('the notification level', () => {
  test('a member chooses Nothing: the bell says so at once, and the server is asked', async () => {
    asked.length = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        setNotificationLevel: (channelId, level) => {
          asked.push([channelId, level]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    await person().click(view.getByRole('button', { name: 'Notifications: mentions and replies' }));
    await expectNoAxeViolations(view.getByRole('menu'));
    await person().click(view.getByRole('menuitemradio', { name: /Nothing/ }));
    expect(asked).toEqual([[IDS.api, 'none']]);
    expect(view.getByRole('button', { name: 'Notifications: nothing' })).toBeDefined();
    view.unmountAll();
  });

  test('each level draws its own bell, so the level shows without opening the menu', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { setNotificationLevel: () => new Promise<void>(() => undefined) },
    });
    const bell = (): string =>
      view
        .getByRole('button', { name: /^Notifications:/ })
        .querySelector('svg')
        ?.getAttribute('class') ?? '';
    expect(bell()).toContain('lucide-bell ');
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    await person().click(view.getByRole('menuitemradio', { name: /Every message/ }));
    expect(bell()).toContain('bell-ring');
    view.unmountAll();
  });

  test('refused, the level it had comes back and the toast says why', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { setNotificationLevel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    await person().click(view.getByRole('menuitemradio', { name: /Every message/ }));
    expect(await view.findByText(/The notification level was not changed\./)).toBeDefined();
    await settle();
    expect(view.getByRole('button', { name: 'Notifications: mentions and replies' })).toBeDefined();
    view.unmountAll();
  });

  test('is not offered where the person is not a member', async () => {
    const seeing = { ...aChannel(IDS.api, 'api'), state: null, notificationLevel: null };
    const view = await mountChannel({
      messages: page([]),
      channels: [seeing, ...someChannels().filter((c) => c.id !== IDS.api)],
    });
    expect(view.queryByRole('button', { name: /^Notifications:/ })).toBeNull();
    view.unmountAll();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await mountChannel({ messages: page([]), locale: 'tr' });
    await person().click(view.getByRole('button', { name: /^Bildirimler:/ }));
    expect(view.getByRole('menuitemradio', { name: /Hiçbir şey/ })).toBeDefined();
    view.unmountAll();
  });
});
