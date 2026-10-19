/**
 * A channel's repository feeds in its details (#79, D-134): an owner's or an admin's, in its three
 * states (`UX.md` §8) with a real failure; a feed's last delivery and why it last failed; connecting
 * one, which shows what GitHub needs and the secret once; and disconnecting one, which asks first.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { CreateGitHubFeedRequest, GitHubFeed, MeResponse } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aSession } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const FEED_ID = '0199155c-6200-7b7f-8c11-000000000f01';
const SECRET = 'a'.repeat(64);

const aFeed = (over: Partial<GitHubFeed> = {}): GitHubFeed => ({
  id: FEED_ID,
  channelId: IDS.api,
  repository: 'acme/api',
  events: ['push', 'pull_request'],
  createdAt: '2026-10-14T08:00:00.000Z',
  lastDeliveryAt: null,
  lastFailure: null,
  ...over,
});

const openDetails = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'api' }));
  await settle();
  const dialog = view.getByRole('dialog', { name: 'Details of #api' });
  // The repositories are in their own tab (D-154), which only an owner or an admin has.
  const tab = within(dialog).queryByRole('tab', { name: 'Integrations' });
  if (tab !== null) {
    await person().click(tab);
    await settle();
  }
  return dialog;
};

const feedsOf = (dialog: HTMLElement): HTMLElement =>
  within(dialog).getByRole('region', { name: 'GitHub repositories' });

describe('a channel’s repositories, as an owner sees them', () => {
  test('a failure is said with Retry, and read again it is the empty state', async () => {
    let asked = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        githubFeeds: () => {
          asked += 1;
          return asked === 1
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
            : Promise.resolve([]);
        },
      },
    });
    const dialog = await openDetails(view);
    const feeds = feedsOf(dialog);
    expect(within(feeds).getByText(/went wrong/i)).toBeDefined();
    await person().click(within(feeds).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(feeds).getByText(/No repository is connected/)).toBeDefined();
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('each feed says what it posts, when it was last reached, and why it last failed', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        githubFeeds: () =>
          Promise.resolve([
            aFeed({
              lastDeliveryAt: '2026-10-14T09:00:00.000Z',
              lastFailure: { reason: 'rate_limited', at: '2026-10-14T09:30:00.000Z' },
            }),
          ]),
      },
    });
    const feeds = feedsOf(await openDetails(view));
    expect(within(feeds).getByText('acme/api')).toBeDefined();
    expect(within(feeds).getByText(/Pushes, Pull requests · Last delivery/)).toBeDefined();
    expect(within(feeds).getByText(/Lost .*: too many deliveries at once/)).toBeDefined();
    view.unmountAll();
  });

  test('connecting shows the address, the content type and the secret once, each copied', async () => {
    const asked: CreateGitHubFeedRequest[] = [];
    const copied: string[] = [];
    let listed = 0;
    const view = await mountChannel({
      messages: page([]),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
      api: {
        githubFeeds: () => {
          listed += 1;
          return Promise.resolve(listed === 1 ? [] : [aFeed()]);
        },
        connectGitHubFeed: (_channelId, input) => {
          asked.push(input);
          return Promise.resolve({
            feed: aFeed(),
            webhookPath: `/api/webhooks/github/${FEED_ID}`,
            secret: SECRET,
          });
        },
      },
    });
    const dialog = await openDetails(view);
    const feeds = feedsOf(dialog);
    await person().type(within(feeds).getByLabelText(/^Repository/), 'Acme/API');
    await person().click(within(feeds).getByLabelText('Pull requests'));
    await person().click(within(feeds).getByRole('button', { name: 'Connect' }));
    await settle();

    expect(asked).toEqual([{ repository: 'Acme/API', events: ['push', 'pull_request'] }]);
    const setup = within(feeds).getByRole('region', { name: /Add this webhook to acme\/api/ });
    expect(
      within(setup).getByText(`${window.location.origin}/api/webhooks/github/${FEED_ID}`),
    ).toBeDefined();
    expect(within(setup).getByText('application/json')).toBeDefined();
    expect(within(setup).getByText(SECRET)).toBeDefined();
    expectFocusOn(within(setup).getByRole('heading'));
    await person().click(within(setup).getByRole('button', { name: 'Copy the Secret' }));
    await settle();
    expect(copied).toEqual([SECRET]);
    // The list is read again, and has the feed.
    expect(within(feeds).getByText('acme/api')).toBeDefined();
    await expectNoAxeViolations(dialog);

    await person().click(within(setup).getByRole('button', { name: 'Done' }));
    expect(within(feeds).queryByText(SECRET)).toBeNull();
    expect(within(feeds).getByRole('button', { name: 'Connect' })).toBeDefined();
    view.unmountAll();
  });

  test('what the contract refuses is said before a round trip; what the server refuses, after', async () => {
    let connected = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        githubFeeds: () => Promise.resolve([]),
        connectGitHubFeed: () => {
          connected += 1;
          return Promise.reject(new ApiError(409, 'GITHUB_FEED_EXISTS', 'exists'));
        },
      },
    });
    const feeds = feedsOf(await openDetails(view));
    const field = within(feeds).getByLabelText(/^Repository/);
    await person().type(field, 'not a repository');
    await person().click(within(feeds).getByRole('button', { name: 'Connect' }));
    expect(within(feeds).getByText('Write the repository as owner/name.')).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await person().clear(field);
    await person().type(field, 'acme/api');
    await person().click(within(feeds).getByLabelText('Pushes'));
    await person().click(within(feeds).getByRole('button', { name: 'Connect' }));
    expect(within(feeds).getByText('Choose at least one thing to post.')).toBeDefined();
    expect(connected).toBe(0);

    await person().click(within(feeds).getByLabelText('Releases'));
    await person().click(within(feeds).getByRole('button', { name: 'Connect' }));
    await settle();
    expect(connected).toBe(1);
    expect(within(feeds).getByRole('alert').textContent).toContain(
      'This channel already hears from that repository.',
    );
    view.unmountAll();
  });

  test('disconnecting asks first; Cancel gives focus back; Disconnect removes it', async () => {
    const removed: [string, string][] = [];
    let listed = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        githubFeeds: () => {
          listed += 1;
          return Promise.resolve(listed === 1 ? [aFeed()] : []);
        },
        disconnectGitHubFeed: (channelId, feedId) => {
          removed.push([channelId, feedId]);
          return Promise.resolve();
        },
      },
    });
    const feeds = feedsOf(await openDetails(view));
    const ask = within(feeds).getByRole('button', { name: 'Disconnect acme/api' });
    await person().click(ask);
    const question = within(feeds).getByRole('group', { name: /Disconnect acme\/api\?/ });
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().click(within(question).getByRole('button', { name: 'Cancel' }));
    expectFocusOn(within(feeds).getByRole('button', { name: 'Disconnect acme/api' }));
    expect(removed).toEqual([]);

    await person().click(within(feeds).getByRole('button', { name: 'Disconnect acme/api' }));
    await person().click(
      within(within(feeds).getByRole('group', { name: /Disconnect acme\/api\?/ })).getByRole(
        'button',
        { name: 'Disconnect' },
      ),
    );
    await settle();
    expect(removed).toEqual([[IDS.api, FEED_ID]]);
    expect(within(feeds).getByText(/No repository is connected/)).toBeDefined();
    view.unmountAll();
  });
});

describe('as a member', () => {
  test('there is no repositories section, and nothing is asked for', async () => {
    const session = aSession();
    const member: MeResponse = {
      ...session,
      memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
    };
    let asked = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        me: () => Promise.resolve(member),
        githubFeeds: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      },
    });
    const dialog = await openDetails(view);
    expect(within(dialog).queryByRole('tab', { name: 'Integrations' })).toBeNull();
    expect(within(dialog).queryByRole('region', { name: 'GitHub repositories' })).toBeNull();
    expect(asked).toBe(0);
    view.unmountAll();
  });
});

describe('in Turkish', () => {
  test('it speaks Turkish', async () => {
    const view = await mountChannel({
      messages: page([]),
      locale: 'tr',
      api: { githubFeeds: () => Promise.resolve([]) },
    });
    await person().click(view.getByRole('button', { name: 'api' }));
    await settle();
    const dialog = view.getByRole('dialog');
    await person().click(within(dialog).getByRole('tab', { name: 'Entegrasyonlar' }));
    await settle();
    expect(within(dialog).getByRole('region', { name: 'GitHub depoları' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Bağla' })).toBeDefined();
    view.unmountAll();
  });
});
