/**
 * The channel's notification level, from its header (D-107): for a member only, painted before the
 * server answers, put back when it refuses, and said in both languages.
 */
import { describe, expect, test } from 'bun:test';
import type { NotificationLevel } from '@purlay/types';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { mountChannel, page, settle } from '../../../testing/channel-harness';
import { installDom } from '../../../testing/dom';
import { IDS, aChannel, someChannels } from '../../../testing/fixtures';
import { person } from '../../../testing/user';

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
    await person().click(view.getByRole('menuitem', { name: /Sessize al/ }));
    expect(view.getByRole('menuitem', { name: '1 saat (13:00)' })).toBeDefined();
    expect(view.getByRole('menuitem', { name: 'Yarına kadar' })).toBeDefined();
    view.unmountAll();
  });
});

describe('muting for a while (D-329)', () => {
  const timed: [string, NotificationLevel, string | undefined][] = [];

  test('offers five whiles, each a span saying its clock time; one chosen is asked for and said', async () => {
    timed.length = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        setNotificationLevel: (channelId, level, until) => {
          timed.push([channelId, level, until]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    await person().click(view.getByRole('menuitem', { name: /Mute for/ }));
    // The harness's clock is 12:00 UTC on 9 September, its zone UTC.
    expect(
      view
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
        .filter((words) => words !== 'Mute for…'),
    ).toEqual([
      'For 15 minutes (12:15)',
      'For 1 hour (13:00)',
      'For 8 hours (20:00)',
      'For 24 hours (11:59)',
      'Until tomorrow',
    ]);
    await expectNoAxeViolations(view.getAllByRole('menu').at(-1) ?? document.body);
    await person().click(view.getByRole('menuitem', { name: 'For 1 hour (13:00)' }));
    expect(timed).toEqual([[IDS.api, 'none', '2026-09-09T13:00:00.000Z']]);
    expect(view.getByRole('button', { name: 'Notifications: nothing until 13:00' })).toBeDefined();
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    expect(view.getByText('Muted until 13:00')).toBeDefined();
    view.unmountAll();
  });

  test('until tomorrow is nine tomorrow morning on the viewer’s clock', async () => {
    timed.length = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        setNotificationLevel: (channelId, level, until) => {
          timed.push([channelId, level, until]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    await person().click(view.getByRole('menuitem', { name: /Mute for/ }));
    await person().click(view.getByRole('menuitem', { name: 'Until tomorrow' }));
    expect(timed).toEqual([[IDS.api, 'none', '2026-09-10T09:00:00.000Z']]);
    // Another day than today: the whole date is said, not a bare clock time.
    expect(
      view.getByRole('button', { name: /^Notifications: nothing until Sep 10, 2026/ }),
    ).toBeDefined();
    view.unmountAll();
  });

  test('a mute the server says lasts is shown; Nothing chosen again makes it for good', async () => {
    timed.length = 0;
    const muted = {
      ...aChannel(IDS.api, 'api'),
      notificationLevel: 'none' as const,
      notificationLevelUntil: '2026-09-09T18:30:00.000Z',
    };
    const view = await mountChannel({
      messages: page([]),
      channels: [muted, ...someChannels().filter((c) => c.id !== IDS.api)],
      api: {
        setNotificationLevel: (channelId, level, until) => {
          timed.push([channelId, level, until]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    await person().click(view.getByRole('button', { name: 'Notifications: nothing until 18:30' }));
    expect(view.getByText('Muted until 18:30')).toBeDefined();
    await person().click(view.getByRole('menuitemradio', { name: /Nothing/ }));
    expect(timed).toEqual([[IDS.api, 'none', undefined]]);
    expect(view.getByRole('button', { name: 'Notifications: nothing' })).toBeDefined();
    view.unmountAll();
  });

  test('refused, the level and its end come back and the toast says why', async () => {
    const muted = {
      ...aChannel(IDS.api, 'api'),
      notificationLevel: 'none' as const,
      notificationLevelUntil: '2026-09-09T18:30:00.000Z',
    };
    const view = await mountChannel({
      messages: page([]),
      channels: [muted, ...someChannels().filter((c) => c.id !== IDS.api)],
      api: { setNotificationLevel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    await person().click(view.getByRole('button', { name: /^Notifications:/ }));
    await person().click(view.getByRole('menuitemradio', { name: /Every message/ }));
    expect(await view.findByText(/The notification level was not changed\./)).toBeDefined();
    await settle();
    expect(view.getByRole('button', { name: 'Notifications: nothing until 18:30' })).toBeDefined();
    view.unmountAll();
  });
});
