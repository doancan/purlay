/**
 * The Updates section of the inbox (D-286) as a person meets it: a list of its own beside the conversations', offered only where
 * a running module writes notices, with the rail's dot, reading that paints at once, a kind the page does not know said plainly,
 * and the states every list has.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { InboxEntry, InboxPage, MarkInboxReadRequest, MeResponse } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { ALICE, IDS, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { settle } from '../../../testing/channel-harness';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

const id = (n: number): string =>
  `00000000-0000-4000-8000-${(0xe00 + n).toString(16).padStart(12, '0')}`;

const entry = (n: number, over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: id(n),
  module: 'issues',
  kind: 'issue_assigned',
  actorId: ALICE.id,
  subject: { type: 'issue', id: id(100 + n) },
  params: { title: 'A title nobody should see in the sentence' },
  readAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  ...over,
});

const page = (data: readonly InboxEntry[], unreadCount?: number): InboxPage => ({
  data: [...data],
  nextCursor: null,
  unreadCount: unreadCount ?? data.filter((one) => one.readAt === null).length,
});

/** A server that runs issues beside chat, or chat alone. */
const session = (modules: MeResponse['modules'] = ['chat', 'issues']): MeResponse => ({
  ...aSession(),
  modules,
});

const visit = async (
  api: Partial<Api>,
  path = `/w/acme/c/${IDS.api}`,
  modules?: MeResponse['modules'],
): ReturnType<typeof renderApp> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path, api: aSignedInApi({ me: () => Promise.resolve(session(modules)), ...api }) },
  );
  await settle();
  return view;
};

type View = Awaited<ReturnType<typeof visit>>;

const inboxButton = (view: View): HTMLElement =>
  within(view.getByRole('navigation', { name: 'Places' })).getByRole('button', { name: /Inbox/ });

const openUpdates = async (view: View): Promise<HTMLElement> => {
  await person().click(inboxButton(view));
  await settle();
  const panel = view.getByRole('dialog', { name: 'Inbox' });
  await person().click(
    within(within(panel).getByRole('group', { name: 'Category' })).getByRole('button', {
      name: 'Updates',
    }),
  );
  await settle();
  return panel;
};

describe('the Updates section', () => {
  test('is offered where a running module writes notices, and asked for nothing where none does', async () => {
    let asked = 0;
    const inbox = (): Promise<InboxPage> => {
      asked += 1;
      return Promise.resolve(page([]));
    };
    const alone = await visit({ inbox }, `/w/acme/c/${IDS.api}`, ['chat']);
    await person().click(inboxButton(alone));
    await settle();
    const categories = within(
      within(alone.getByRole('dialog', { name: 'Inbox' })).getByRole('group', { name: 'Category' }),
    );
    // A count, not the element: a failed assertion on a node would print the whole page.
    expect(categories.queryAllByRole('button', { name: 'Updates' }).length).toBe(0);
    expect(asked).toBe(0);
    alone.unmount();

    const both = await visit({ inbox });
    await person().click(inboxButton(both));
    await settle();
    expect(
      within(
        within(both.getByRole('dialog', { name: 'Inbox' })).getByRole('group', {
          name: 'Category',
        }),
      ).getByRole('button', { name: 'Updates' }),
    ).toBeDefined();
    both.unmount();
  });

  test('lights the rail’s dot while an update waits, and not in Deep Work, which holds the badges back', async () => {
    const waiting = await visit({ inbox: () => Promise.resolve(page([entry(1)])) });
    expect(inboxButton(waiting).textContent).toContain('unread');
    waiting.unmount();

    const none = await visit({ inbox: () => Promise.resolve(page([])) });
    expect(inboxButton(none).textContent.trim()).toBe('Inbox');
    none.unmount();

    const quiet = {
      ...session(),
      memberships: session().memberships.map((m) => ({
        ...m,
        deepWorkUntil: '2026-09-09T13:00:00.000Z',
      })),
    };
    const held = await visit({
      me: () => Promise.resolve(quiet),
      inbox: () => Promise.resolve(page([entry(1)])),
    });
    expect(inboxButton(held).textContent.trim()).toBe('Inbox');
    held.unmount();
  });

  test('says an assignment in the person’s words, never with the title, and opening it reads it, goes to issues and takes the dot away', async () => {
    const reads: MarkInboxReadRequest[] = [];
    let read = false;
    const view = await visit({
      inbox: () =>
        Promise.resolve(
          page(read ? [entry(1, { readAt: '2026-09-09T08:01:00.000Z' })] : [entry(1)]),
        ),
      readInbox: (_workspace, input) => {
        reads.push(input);
        read = true;
        return Promise.resolve();
      },
    });
    expect(inboxButton(view).textContent).toContain('unread');
    const panel = await openUpdates(view);
    const row = await within(panel).findByRole('button', {
      name: /Alice assigned an issue to you/,
    });
    expect(row.textContent).not.toContain('nobody should see');
    await expectNoAxeViolations(panel);

    await person().click(row);
    await settle();
    expect(reads).toEqual([{ ids: [id(1)] }]);
    expect(view.queryAllByRole('dialog', { name: 'Inbox' }).length).toBe(0);
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/issues');
    expect(inboxButton(view).textContent.trim()).toBe('Inbox');
    view.unmount();
  });

  test('Mark all read reads every update of the workspace, and is drawn only while one waits', async () => {
    const reads: MarkInboxReadRequest[] = [];
    const view = await visit({
      inbox: () => Promise.resolve(page([entry(1), entry(2)])),
      readInbox: (_workspace, input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    const panel = await openUpdates(view);
    await person().click(await within(panel).findByRole('button', { name: 'Mark all read' }));
    await settle();
    expect(reads).toEqual([{ all: true }]);
    view.unmount();

    const quiet = await visit({
      inbox: () => Promise.resolve(page([entry(1, { readAt: '2026-09-09T08:01:00.000Z' })])),
    });
    const calm = await openUpdates(quiet);
    expect(within(calm).queryAllByRole('button', { name: 'Mark all read' }).length).toBe(0);
    quiet.unmount();
  });

  test('a kind this page does not know is said plainly by its module, opens nothing, and is still read', async () => {
    const reads: MarkInboxReadRequest[] = [];
    const view = await visit({
      inbox: () => Promise.resolve(page([entry(7, { module: 'wiki', kind: 'page_edited' })])),
      readInbox: (_workspace, input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    const panel = await openUpdates(view);
    const row = await within(panel).findByRole('button', { name: /wiki has an update for you/ });
    await person().click(row);
    await settle();
    expect(reads).toEqual([{ ids: [id(7)] }]);
    // Nothing to open: the panel and the place stay as they were.
    expect(view.getByRole('dialog', { name: 'Inbox' })).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('a person whose account is gone is still a sentence, and the list is the page’s too, a page at a time', async () => {
    let before: string | undefined;
    const view = await visit(
      {
        inbox: (_workspace, at = {}) => {
          before = at.before;
          return Promise.resolve(
            at.before === undefined
              ? { ...page([entry(1, { actorId: null })]), nextCursor: id(1) }
              : page([entry(2)]),
          );
        },
      },
      '/w/acme/inbox?category=updates',
    );
    const onPage = await view.findByRole('button', { name: /assigned an issue to you/ });
    expect(onPage.textContent).toContain('Deleted user');
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(before).toBe(id(1));
    expect(view.getAllByRole('button', { name: /assigned an issue to you/ })).toHaveLength(2);
    view.unmount();
  });

  test('is loading, failed and empty in words of its own, and a failed one tries again', async () => {
    let calls = 0;
    const view = await visit({
      inbox: (_workspace, at = {}) => {
        // The rail's dot asks for a page of one; the list is the one asking without `unreadOnly`.
        if (at.unreadOnly === true) return Promise.resolve(page([]));
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve(page([]));
      },
    });
    const panel = await openUpdates(view);
    expect(await within(panel).findByText("Couldn't load your inbox")).toBeDefined();
    await person().click(await within(panel).findByRole('button', { name: 'Retry' }));
    await settle();
    expect(await within(panel).findByText('No updates')).toBeDefined();
    view.unmount();
  });

  test('a read the server refuses is said, and the list is read again from the server', async () => {
    let asked = 0;
    const view = await visit({
      inbox: () => {
        asked += 1;
        return Promise.resolve(page([entry(1)]));
      },
      readInbox: () => Promise.reject(new Error('refused')),
    });
    const panel = await openUpdates(view);
    const before = asked;
    await person().click(
      await within(panel).findByRole('button', { name: /Alice assigned an issue/ }),
    );
    await settle();
    expect(asked).toBeGreaterThan(before);
    expect(view.getByText(/Not marked read\./)).toBeDefined();
    view.unmount();
  });
});
