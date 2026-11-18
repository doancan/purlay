/**
 * The Reminders tab of Saved as a person meets it: counted in its label, listing what they asked to be
 * reminded of with where and who, opening the message in its conversation, changed and removed at once
 * and said when refused, read again on opening, and with its loading, failed and empty states in both
 * languages. Without the server's reminders the tab is not drawn and its address is In progress.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { MeResponse, MessageReminder } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { expectNoAxeViolations } from '../../../testing/axe';
import { createFormatters } from '../../../i18n/format';
import { installDom } from '../../../testing/dom';
import { feedWorld } from '../../../testing/feed-world';
import { IDS, aMessage, aSession, aSignedInApi, messageIdAt } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { FeedPortsContext } from '../channel/feed-ports';
import { tabIn } from './saved-screen';

installDom();

/** A time as the page says it: the ICU of the machine decides how, so a test asks the same formatter. */
const when = (iso: string): string => createFormatters('en', 'UTC').absolute(iso);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const reminder = (n: number, remindAt: string): MessageReminder => ({
  id: `0199155c-${(0x7000 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`,
  message: aMessage(n, { content: `remind words ${String(n)}` }),
  remindAt,
  createdAt: '2026-09-09T08:00:00.000Z',
});

const SOON = reminder(1, '2026-09-10T08:30:00.000Z');
const LATER = reminder(2, '2026-09-12T16:00:00.000Z');

type View = Awaited<ReturnType<typeof renderApp>>;

const visit = async (
  api: Partial<Api>,
  options: { path?: string; locale?: 'tr'; modules?: ('chat' | 'issues')[] } = {},
): Promise<View> => {
  const view = await renderApp(
    <FeedPortsContext.Provider value={feedWorld().ports}>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </FeedPortsContext.Provider>,
    {
      path: options.path ?? '/w/acme/saved?state=reminders',
      api: aSignedInApi({
        saved: () => Promise.resolve({ data: [], nextCursor: null }),
        ...(options.modules === undefined
          ? {}
          : {
              me: (): Promise<MeResponse> =>
                Promise.resolve({ ...aSession(), modules: options.modules ?? [] }),
            }),
        ...api,
      }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    },
  );
  await settle();
  return view;
};

const removeFirst = async (view: View): Promise<void> => {
  const [first] = within(view.getByRole('main')).getAllByRole('button', {
    name: 'Remove reminder',
  });
  if (first === undefined) throw new Error('no reminder to remove');
  await person().click(first);
};

describe('the address', () => {
  test('names the Reminders tab only where reminders are drawn', () => {
    expect(tabIn('?state=reminders', true)).toBe('reminders');
    expect(tabIn('?state=reminders', false)).toBe('in_progress');
    expect(tabIn('?state=archived', true)).toBe('archived');
    expect(tabIn('', true)).toBe('in_progress');
  });
});

describe('the Reminders tab', () => {
  test('lists the reminders soonest first: when, who, where and the words, with the count in the tab', async () => {
    const view = await visit({ listReminders: () => Promise.resolve([SOON, LATER]) });
    const main = within(view.getByRole('main'));
    expect(main.getByRole('button', { name: 'Reminders (2)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const rows = main.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows[0]).toContain('remind words 1');
    expect(rows[0]).toContain('#api');
    expect(rows[0]).toContain(when('2026-09-10T08:30:00Z'));
    expect(rows[1]).toContain('remind words 2');
    expect(
      view.container.querySelector('time[datetime="2026-09-10T08:30:00.000Z"]'),
    ).not.toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a tab of the others is asked for in the address, and this one is kept in it', async () => {
    const view = await visit(
      { listReminders: () => Promise.resolve([SOON]) },
      { path: '/w/acme/saved' },
    );
    await person().click(view.getByRole('button', { name: 'Reminders (1)' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/saved?state=reminders');
    expect(view.getByText('remind words 1')).toBeDefined();
    view.unmount();
  });

  test('a reminder opens its message in its conversation', async () => {
    const view = await visit({ listReminders: () => Promise.resolve([SOON]) });
    await person().click(view.getByRole('button', { name: /remind words 1/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?message=${messageIdAt(1)}`);
    view.unmount();
  });

  test('a reminder on a reply opens the thread it is in', async () => {
    const reply: MessageReminder = {
      ...reminder(3, '2026-09-11T09:00:00.000Z'),
      message: aMessage(3, { content: 'remind words 3', parentId: messageIdAt(1) }),
    };
    const view = await visit({ listReminders: () => Promise.resolve([reply]) });
    await person().click(view.getByRole('button', { name: /remind words 3/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?thread=${messageIdAt(1)}`);
    view.unmount();
  });

  test('Remove takes the row away at once and asks; a refusal puts it back and says so', async () => {
    const cancelled: string[] = [];
    let refuse = true;
    const view = await visit({
      listReminders: () =>
        Promise.resolve(cancelled.length > 0 && !refuse ? [LATER] : [SOON, LATER]),
      cancelMessageReminder: (id) => {
        cancelled.push(id);
        return refuse ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'No')) : Promise.resolve();
      },
    });
    const main = within(view.getByRole('main'));
    await removeFirst(view);
    await settle();
    expect(cancelled).toEqual([SOON.message.id]);
    expect(view.getByText(/^The reminder was not removed\./)).toBeDefined();
    expect(main.getAllByRole('listitem')).toHaveLength(2);

    refuse = false;
    await removeFirst(view);
    await settle();
    expect(main.getAllByRole('listitem')).toHaveLength(1);
    expect(main.getByRole('button', { name: 'Reminders (1)' })).toBeDefined();
    view.unmount();
  });

  test('Change… asks for a new time and replaces the reminder', async () => {
    const set: string[] = [];
    const view = await visit({
      listReminders: () => Promise.resolve([SOON]),
      setMessageReminder: (id, at) => {
        set.push(`${id} ${at}`);
        return Promise.resolve({ ...SOON, remindAt: at });
      },
    });
    await person().click(within(view.getByRole('main')).getByRole('button', { name: 'Change…' }));
    const dialog = await view.findByRole('dialog', { name: 'Remind me about this message' });
    const input = within(dialog).getByLabelText('Remind me at');
    expect((input as HTMLInputElement).value).toBe('2026-09-10T08:30');
    await person().clear(input);
    await person().type(input, '2026-09-20T10:00');
    await person().click(within(dialog).getByRole('button', { name: 'Save' }));
    await settle();
    expect(set).toEqual([`${SOON.message.id} 2026-09-20T10:00:00.000Z`]);
    view.unmount();
  });

  test('is read again on opening, even when the list is already held', async () => {
    let reads = 0;
    const view = await visit(
      {
        listReminders: () => {
          reads++;
          return Promise.resolve([SOON]);
        },
      },
      { path: '/w/acme/saved' },
    );
    const before = reads;
    await person().click(view.getByRole('button', { name: 'Reminders (1)' }));
    await settle();
    expect(reads).toBeGreaterThan(before);
    view.unmount();
  });

  test('a frame that reminders changed elsewhere brings the new list', async () => {
    let held = [SOON];
    const view = await visit({ listReminders: () => Promise.resolve(held) });
    expect(within(view.getByRole('main')).getAllByRole('listitem')).toHaveLength(1);
    held = [SOON, LATER];
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: keys.reminders(IDS.workspace) });
    });
    await settle();
    expect(within(view.getByRole('main')).getAllByRole('listitem')).toHaveLength(2);
    view.unmount();
  });

  test('says when it is loading, when it failed — with Retry — and when there is nothing', async () => {
    const loading = await visit({ listReminders: () => new Promise(() => undefined) });
    expect(loading.getByText('Loading your reminders')).toBeDefined();
    loading.unmount();

    let fail = true;
    const failed = await visit({
      listReminders: () =>
        fail ? Promise.reject(new ApiError(500, 'INTERNAL', 'x')) : Promise.resolve([]),
    });
    expect(failed.getByText('Your reminders could not be loaded')).toBeDefined();
    fail = false;
    await person().click(failed.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(failed.getByText('No reminders')).toBeDefined();
    expect(failed.getByText(/^Choose Remind me… on any message/)).toBeDefined();
    failed.unmount();
  });

  test('is in Turkish when the interface is', async () => {
    const view = await visit({ listReminders: () => Promise.resolve([SOON]) }, { locale: 'tr' });
    const main = within(view.getByRole('main'));
    expect(main.getByRole('button', { name: 'Hatırlatmalar (1)' })).toBeDefined();
    expect(main.getByRole('button', { name: 'Değiştir…' })).toBeDefined();
    expect(main.getByRole('button', { name: 'Hatırlatmayı kaldır' })).toBeDefined();
    view.unmount();
  });
});

describe('where the server does not remind', () => {
  test('there is no tab, and its address shows In progress', async () => {
    const view = await visit(
      {
        listReminders: () => {
          throw new Error('no reminders were to be asked for');
        },
      },
      { modules: ['issues'], path: '/w/acme/saved?state=reminders' },
    );
    expect(view.queryByRole('button', { name: /^Reminders/ })).toBeNull();
    expect(view.queryByRole('button', { name: /^Hatırlatmalar/ })).toBeNull();
    view.unmount();
  });
});
