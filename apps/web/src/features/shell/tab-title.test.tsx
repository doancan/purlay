/**
 * The tab's title (`UX.md` §2): where the person is, which workspace, and what needs them — the
 * words in both languages, the count from the badges' own cache entry, quiet in Deep Work, and the
 * page's own title back once the shell is gone.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, MeResponse } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { keys } from '../../data/keys';
import { en } from '../../i18n/catalogue/en';
import { tr } from '../../i18n/catalogue/tr';
import { createTranslate } from '../../i18n/translate';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  IDS,
  ME,
  aChannel,
  aSession,
  aSignedInApi,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { tabTitle, waitingCount } from './tab-title';

installDom();

const waiting = (
  unreadMentionCount: number,
  unreadCount = unreadMentionCount,
): Channel['state'] => ({
  lastReadMessageId: null,
  unreadCount,
  unreadMentionCount,
});

describe('the words', () => {
  const english = createTranslate('en', en);
  const turkish = createTranslate('tr', tr);

  test('a place, the workspace and the product, with the count first only when there is one', () => {
    expect(tabTitle(english, { place: '#api', workspace: 'Acme', waiting: 0 })).toBe(
      '#api · Acme · Purlay',
    );
    expect(tabTitle(english, { place: '#api', workspace: 'Acme', waiting: 3 })).toBe(
      '(3) #api · Acme · Purlay',
    );
    expect(tabTitle(english, { place: null, workspace: 'Acme', waiting: 0 })).toBe('Acme · Purlay');
    expect(tabTitle(english, { place: null, workspace: 'Acme', waiting: 1200 })).toBe(
      '(1,200) Acme · Purlay',
    );
  });

  test('in Turkish, with its own number format', () => {
    expect(tabTitle(turkish, { place: 'Gelen kutusu', workspace: 'Acme', waiting: 1200 })).toBe(
      '(1.200) Gelen kutusu · Acme · Purlay',
    );
  });

  test('counts what needs the person, not every unread message, and nothing for a channel not joined', () => {
    expect(
      waitingCount([
        aChannel(IDS.api, 'api', { state: waiting(2, 40) }),
        aChannel(IDS.deploys, 'deploys', { state: waiting(0, 9) }),
        aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE, state: waiting(1) }),
        aChannel(IDS.browse, 'browse', { state: null }),
      ]),
    ).toBe(3);
  });
});

describe('the title of the tab', () => {
  const visit = async (
    path: string,
    channels: Channel[],
    me: MeResponse = aSession(),
  ): ReturnType<typeof renderApp> => {
    const view = await renderApp(<Outlet />, {
      path,
      api: aSignedInApi({
        me: () => Promise.resolve(me),
        channels: () => Promise.resolve(channels),
      }),
    });
    await settle();
    return view;
  };

  const elsewhere = (): Channel[] =>
    someChannels().map((c) => (c.id === IDS.deploys ? { ...c, state: waiting(2) } : c));

  test('names the channel, and counts the mentions waiting in another', async () => {
    await visit(`/w/acme/c/${IDS.api}`, elsewhere());
    expect(document.title).toBe('(2) #api · acme-eng · Purlay');
  });

  test('follows the count as it changes in the cache the socket writes to', async () => {
    const view = await visit(`/w/acme/c/${IDS.api}`, someChannels());
    expect(document.title).toBe('#api · acme-eng · Purlay');
    act(() => {
      view.world.client.setQueryData(keys.channels(IDS.workspace), elsewhere());
    });
    await settle();
    expect(document.title).toBe('(2) #api · acme-eng · Purlay');
  });

  test('a direct message is named for the other person, and a note to self says so', async () => {
    const withAlice = [
      ...someChannels(),
      aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE }),
    ];
    await visit(`/w/acme/c/${IDS.dm}`, withAlice);
    expect(document.title).toBe('Alice · acme-eng · Purlay');

    const self = [...someChannels(), aChannel(IDS.dm, null, { type: 'direct_message', peer: ME })];
    await visit(`/w/acme/c/${IDS.dm}`, self);
    expect(document.title).toBe('Dogancan (you) · acme-eng · Purlay');
  });

  test('names the inbox, search and open questions, in the language of the page', async () => {
    await visit('/w/acme/inbox', someChannels());
    expect(document.title).toBe('Inbox · acme-eng · Purlay');
    await visit('/w/acme/search', someChannels());
    expect(document.title).toBe('Search · acme-eng · Purlay');
    await visit('/w/acme/questions', someChannels());
    expect(document.title).toBe('Open questions · acme-eng · Purlay');
  });

  test('in Deep Work it counts nothing, as the badges draw nothing', async () => {
    const me = aSession();
    const quiet: MeResponse = {
      ...me,
      memberships: me.memberships.map((m) => ({ ...m, deepWorkUntil: '2026-09-09T13:00:00.000Z' })),
    };
    await visit(`/w/acme/c/${IDS.api}`, elsewhere(), quiet);
    expect(document.title).toBe('#api · acme-eng · Purlay');
  });

  test('leaving the shell gives the page its own title back', async () => {
    document.title = 'Purlay';
    const view = await visit(`/w/acme/c/${IDS.api}`, elsewhere());
    expect(document.title).toBe('(2) #api · acme-eng · Purlay');
    view.unmount();
    expect(document.title).toBe('Purlay');
  });
});
