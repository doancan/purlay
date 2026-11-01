/**
 * The audit trail (D-26), read in the app at the Audit log page's address (D-146): who did which administrative thing to whom, newest first,
 * in words — and an action this client does not know yet said by its name, never dropped.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { AuditEntry, AuditPage, UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { ALICE, BOB, IDS, ME, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const entryId = (n: number): string => `0199155c-6200-7b7f-8c11-${String(n).padStart(12, '0')}`;
const anEntry = (n: number, over: Partial<AuditEntry>): AuditEntry => ({
  id: entryId(n),
  actor: ME,
  action: 'channel.created',
  targetType: 'channel',
  targetId: IDS.api,
  metadata: {},
  createdAt: WHEN,
  ...over,
});
const page = (data: AuditEntry[], nextCursor: string | null = null): AuditPage => ({
  data,
  nextCursor,
});

type View = Awaited<ReturnType<typeof renderApp>>;

const render = async (path: string, api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
      ...api,
    }),
  });
  await settle();
  return view;
};

/** The Audit log page, loaded: its chunk is lazy, so the heading is waited for. */
const openPage = async (api: Partial<Api>, role: UserRole = 'owner'): Promise<View> => {
  const view = await render('/w/acme/settings/audit', api, role);
  await view.findByRole('heading', { level: 1, name: 'Audit log' });
  await settle();
  return view;
};

const lines = (view: View): string[] =>
  within(view.getByRole('list', { name: 'Audit log' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('[data-audit-line]')?.textContent ?? '');

describe('the audit log', () => {
  test('is an owner’s and an admin’s; a member is not offered it, and its address is not found', async () => {
    const member = await render('/w/acme/settings/audit', {}, 'member');
    expect(await member.findByText('Nothing here')).toBeDefined();
    expect(member.queryByRole('link', { name: 'Audit log' })).toBeNull();
    member.unmount();
    const admin = await openPage({ audit: () => Promise.resolve(page([])) }, 'admin');
    expect(admin.getByRole('link', { name: 'Audit log' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('a channel renamed is said with the name it had and the one it has (D-123)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(1, {
              action: 'channel.renamed',
              metadata: { from: 'general', to: 'genel-sohbet' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([`${ME.displayName} renamed #general to #genel-sohbet`]);
  });

  test('a channel archived is said by the name it had, since it is no longer listed (D-123)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([anEntry(1, { action: 'channel.archived', metadata: { name: 'general' } })]),
        ),
    });
    expect(lines(view)).toEqual([`${ME.displayName} archived #general`]);
  });

  test('the nightly purge is said with what it cleared, and no person, since nobody did it (D-139 §3)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(1, {
              action: 'retention.purged',
              actor: null,
              targetType: 'workspace',
              metadata: { days: '30', messages: '12', files: '2' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual(['History older than 30 days was cleared: 12 messages, 2 files']);
  });

  test('a quota changed by the operator is said in sizes, and by no person (D-173 §4)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(1, {
              action: 'storage.quota_changed',
              actor: null,
              targetType: 'workspace',
              metadata: { from: String(5 * 1024 ** 3), to: String(10 * 1024 ** 3) },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual(['The storage quota was changed from 5 GB to 10 GB']);
  });

  test('a window changed is said in the reader’s words, forever or in days (D-139 §4)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'retention.changed',
              targetType: 'workspace',
              metadata: { from: '90', to: 'forever' },
            }),
            anEntry(1, {
              action: 'retention.changed',
              targetType: 'workspace',
              metadata: { from: 'forever', to: '90' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} changed how long history is kept from 90 days to forever`,
      `${ME.displayName} changed how long history is kept from forever to 90 days`,
    ]);
  });

  test('a channel’s window changed is said in the reader’s words, the channel named only to a viewer who can see it (D-225)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'channel.retention_changed',
              // A channel this viewer cannot see — private and not theirs — stays unnamed.
              targetId: entryId(99),
              metadata: { from: '400', to: 'workspace' },
            }),
            anEntry(1, {
              action: 'channel.retention_changed',
              metadata: { from: 'workspace', to: 'forever' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} changed how long a channel keeps its history from 400 days to the workspace’s window`,
      `${ME.displayName} changed how long #api keeps its history from the workspace’s window to forever`,
    ]);
  });

  test('who posts in a channel is said both ways, the channel named only to a viewer who can see it (D-243)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(3, {
              action: 'channel.posting_changed',
              targetId: entryId(99),
              metadata: { from: 'everyone', to: 'admins' },
            }),
            anEntry(2, {
              action: 'channel.posting_changed',
              metadata: { from: 'admins', to: 'everyone' },
            }),
            anEntry(1, {
              action: 'channel.posting_changed',
              metadata: { from: 'everyone', to: 'admins' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} let only owners and admins post in a channel`,
      `${ME.displayName} let everyone post in #api again`,
      `${ME.displayName} let only owners and admins post in #api`,
    ]);
  });

  test('an account erased is said without naming the person who is gone (D-139 §5)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([anEntry(1, { action: 'account.erased', targetType: 'user', targetId: ME.id })]),
        ),
    });
    expect(lines(view)).toEqual(['A member erased their account']);
  });

  test('an operator’s content erasure is said with what went, and nobody named (D-139 §7)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(1, {
              action: 'content.erased',
              actor: null,
              targetType: 'user',
              metadata: { messages: '7', files: '1' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual(['A member’s writing was erased on request: 7 messages, 1 files']);
  });

  test('an export is said by who asked — the operator when nobody in the workspace did (D-140)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(3, { action: 'workspace.export_requested', targetType: 'workspace' }),
            anEntry(2, {
              action: 'workspace.exported',
              targetType: 'workspace',
              metadata: { scope: 'visible-to-owner', messages: '40' },
            }),
            anEntry(1, {
              action: 'workspace.exported',
              actor: null,
              targetType: 'workspace',
              metadata: { scope: 'all', messages: '41' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} asked for an export of the workspace`,
      `${ME.displayName} exported the workspace, with 40 messages`,
      'The server’s operator exported the workspace, with 41 messages',
    ]);
  });

  test('a deletion asked for says when the content goes, and one taken back says so (D-242)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, { action: 'workspace.deletion_cancelled', targetType: 'workspace' }),
            anEntry(1, {
              action: 'workspace.deletion_requested',
              targetType: 'workspace',
              metadata: { purgeAt: '2026-11-08T09:00:00.000Z' },
            }),
            anEntry(0, { action: 'workspace.deletion_requested', targetType: 'workspace' }),
          ]),
        ),
    });
    const said = lines(view);
    expect(said[0]).toBe(`${ME.displayName} took back the workspace’s deletion`);
    expect(said[1]).toMatch(
      new RegExp(`^${ME.displayName} asked for the workspace to be deleted after .*2026`),
    );
    expect(said[2]).toBe(`${ME.displayName} asked for the workspace to be deleted after `);
  });

  test('says each action in words, with the people and the channel named', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(10, {
              action: 'workspace.renamed',
              targetType: 'workspace',
              metadata: { from: 'acme', to: 'acme-eng' },
            }),
            anEntry(9, {
              action: 'member.role_changed',
              targetType: 'user',
              targetId: ALICE.id,
              metadata: { from: 'member', to: 'admin' },
            }),
            anEntry(8, { action: 'member.removed', targetType: 'user', targetId: BOB.id }),
            anEntry(7, { action: 'channel.created' }),
            anEntry(6, {
              action: 'message.removed_by_moderator',
              targetType: 'message',
              targetId: entryId(1),
              metadata: { authorId: BOB.id },
            }),
            anEntry(5, { action: 'integration.token_set', targetType: 'integration' }),
            anEntry(4, { action: 'integration.token_removed', targetType: 'integration' }),
            anEntry(3, { action: 'invitation.created', targetType: 'invitation' }),
            anEntry(2, { action: 'invitation.revoked', targetType: 'invitation' }),
            anEntry(1, {
              action: 'member.joined',
              actor: ALICE,
              targetType: 'user',
              targetId: ALICE.id,
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} renamed the workspace from acme to acme-eng`,
      `${ME.displayName} changed ${ALICE.displayName}’s role from Member to Admin`,
      `${ME.displayName} removed ${BOB.displayName}`,
      `${ME.displayName} created #api`,
      `${ME.displayName} deleted a message by ${BOB.displayName}`,
      `${ME.displayName} set the GitHub token`,
      `${ME.displayName} removed the GitHub token`,
      `${ME.displayName} made an invitation link`,
      `${ME.displayName} revoked an invitation link`,
      `${ALICE.displayName} joined by an invitation link`,
    ]);
    await expectNoAxeViolations(view.getByRole('main'));
  });

  test('a repository connected to a channel and disconnected is said with the repository (D-134)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'integration.feed_removed',
              targetType: 'integration',
              metadata: { repository: 'acme/api' },
            }),
            anEntry(1, {
              action: 'integration.feed_created',
              targetType: 'integration',
              metadata: { repository: 'acme/api' },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} disconnected acme/api from a channel`,
      `${ME.displayName} connected acme/api to a channel`,
    ]);
  });

  test('somebody added to a channel is said with whom, and the channel only to a viewer who can see it', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'channel.member_added',
              targetType: 'user',
              targetId: ALICE.id,
              // A private channel this viewer is not in stays unnamed, as a feed's does (#691).
              metadata: { channelId: entryId(99) },
            }),
            anEntry(1, {
              action: 'channel.member_added',
              targetType: 'user',
              targetId: BOB.id,
              metadata: { channelId: IDS.api },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} added ${ALICE.displayName} to a channel`,
      `${ME.displayName} added ${BOB.displayName} to #api`,
    ]);
  });

  test('a feed entry names its channel to a viewer who can see it, and only to them (#691)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'integration.feed_removed',
              targetType: 'integration',
              // A channel this viewer cannot see — private and not theirs — stays unnamed.
              metadata: { repository: 'acme/api', channelId: entryId(99) },
            }),
            anEntry(1, {
              action: 'integration.feed_created',
              targetType: 'integration',
              metadata: { repository: 'acme/api', channelId: IDS.api },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} disconnected acme/api from a channel`,
      `${ME.displayName} connected acme/api to #api`,
    ]);
  });

  test('somebody taken out of a channel is said with who, naming the channel only to a viewer who can see it (D-172)', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, {
              action: 'channel.member_removed',
              targetType: 'user',
              targetId: BOB.id,
              // A private channel this viewer is not in stays unnamed.
              metadata: { channelId: entryId(99) },
            }),
            anEntry(1, {
              action: 'channel.member_removed',
              targetType: 'user',
              targetId: BOB.id,
              metadata: { channelId: IDS.api },
            }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName} removed ${BOB.displayName} from a channel`,
      `${ME.displayName} removed ${BOB.displayName} from #api`,
    ]);
  });

  test('an action this client does not know is said by its name; an erased actor or a gone channel is said as such', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(
          page([
            anEntry(2, { action: 'workspace.deleted', targetType: 'workspace' }),
            anEntry(1, { actor: null, targetId: entryId(77) }),
          ]),
        ),
    });
    expect(lines(view)).toEqual([
      `${ME.displayName}: workspace.deleted`,
      'Someone created a channel that is gone',
    ]);
  });

  test('reads older entries by the cursor it was given', async () => {
    const asked: (string | undefined)[] = [];
    const view = await openPage({
      audit: (_workspace, _filter, before) => {
        asked.push(before);
        return Promise.resolve(
          before === undefined ? page([anEntry(2, {})], entryId(2)) : page([anEntry(1, {})]),
        );
      },
    });
    await person().click(
      within(view.getByRole('main')).getByRole('button', { name: 'Load older' }),
    );
    await settle();
    expect(asked).toEqual([undefined, entryId(2)]);
    expect(lines(view)).toHaveLength(2);
    expect(within(view.getByRole('main')).queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  test('an older page that fails says so with the reason, and Load older asks again', async () => {
    let older = 0;
    const view = await openPage({
      audit: (_workspace, _filter, before) => {
        if (before === undefined) return Promise.resolve(page([anEntry(2, {})], entryId(2)));
        older += 1;
        return older === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'down'))
          : Promise.resolve(page([anEntry(1, {})]));
      },
    });
    const main = within(view.getByRole('main'));
    await person().click(main.getByRole('button', { name: 'Load older' }));
    await settle();
    // Not silent: the end of the log and a failed request no longer look the same.
    expect(main.getByRole('alert').textContent).toContain('Older entries did not load.');
    expect(lines(view)).toHaveLength(1);
    await person().click(main.getByRole('button', { name: 'Load older' }));
    await settle();
    expect(main.queryByRole('alert')).toBeNull();
    expect(lines(view)).toHaveLength(2);
  });

  test('empty, it says so; failing, it says why with Retry; reading, it is a status', async () => {
    const empty = await openPage({ audit: () => Promise.resolve(page([])) });
    expect(
      within(empty.getByRole('main')).getByText('Nothing administrative has happened yet.'),
    ).toBeDefined();
    empty.unmount();
    let failing = true;
    const failed = await openPage({
      audit: () =>
        failing ? Promise.reject(new ApiError(0, 'NETWORK', 'down')) : Promise.resolve(page([])),
    });
    failing = false;
    await person().click(within(failed.getByRole('main')).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      within(failed.getByRole('main')).getByText('Nothing administrative has happened yet.'),
    ).toBeDefined();
    failed.unmount();
    const reading = await openPage({ audit: () => new Promise(() => undefined) });
    expect(reading.getByRole('main').querySelector('[role="status"]')).not.toBeNull();
  });
});

/** The filter as the address carries it and the server is asked it (D-222). */
describe('the audit log, narrowed and downloaded', () => {
  const FILTERED = `/w/acme/settings/audit?actor=${ALICE.id}&action=member.removed&from=2026-10-01&to=2026-10-31`;

  const openAt = async (path: string, api: Partial<Api>): Promise<View> => {
    const view = await render(path, api);
    await view.findByRole('heading', { level: 1, name: 'Audit log' });
    await settle();
    return view;
  };

  test('reads its filter from the address, asks the server for it in instants, and shows it chosen', async () => {
    const asked: unknown[] = [];
    const view = await openAt(FILTERED, {
      audit: (_workspace, filter) => {
        asked.push(filter);
        return Promise.resolve(page([]));
      },
    });
    // The test's zone is UTC: a day starts at its midnight, and the last day is in it whole.
    expect(asked).toEqual([
      {
        actorId: ALICE.id,
        action: 'member.removed',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      },
    ]);
    const main = within(view.getByRole('main'));
    expect(main.getByLabelText<HTMLSelectElement>('Action').value).toBe('member.removed');
    expect(main.getByLabelText<HTMLInputElement>('From').value).toBe('2026-10-01');
    expect(main.getByLabelText<HTMLInputElement>('To').value).toBe('2026-10-31');
    expect(main.getByRole('button', { name: `Person ${ALICE.displayName}` })).toBeDefined();
    // Narrowed to nothing is not "nothing has happened".
    expect(main.getByText('No entry matches these filters.')).toBeDefined();
    expect(main.queryByText('Nothing administrative has happened yet.')).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
  });

  test('a filter chosen is a new address, so Back undoes it; Clear filters empties it', async () => {
    const asked: unknown[] = [];
    const view = await openAt('/w/acme/settings/audit', {
      audit: (_workspace, filter) => {
        asked.push(filter);
        return Promise.resolve(page([anEntry(1, {})]));
      },
    });
    const main = within(view.getByRole('main'));
    expect(main.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    await person().selectOptions(main.getByLabelText('Action'), 'Channel created');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/audit?action=channel.created');
    expect(asked.at(-1)).toEqual({ action: 'channel.created' });
    const action = (): string => main.getByLabelText<HTMLSelectElement>('Action').value;
    await act(async () => {
      view.world.history.back();
      await Promise.resolve();
    });
    await settle();
    expect(action()).toBe('');
    await person().selectOptions(main.getByLabelText('Action'), 'Member left');
    await settle();
    expect(asked.at(-1)).toEqual({ action: 'member.left' });
    await person().click(main.getByRole('button', { name: 'Clear filters' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/audit');
    expect(action()).toBe('');
    // The whole trail again, as first read: every filter has its own page of the cache.
    expect(asked).toEqual([{}, { action: 'channel.created' }, { action: 'member.left' }]);
  });

  test('a person picked and days typed are the address', async () => {
    const asked: unknown[] = [];
    const view = await openAt('/w/acme/settings/audit', {
      audit: (_workspace, filter) => {
        asked.push(filter);
        return Promise.resolve(page([]));
      },
    });
    const main = within(view.getByRole('main'));
    await person().click(main.getByRole('button', { name: 'Person Anyone' }));
    await person().click(await view.findByRole('menuitemradio', { name: ALICE.displayName }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/settings/audit?actor=${ALICE.id}`);
    await person().type(main.getByLabelText('From'), '2026-10-01');
    await person().type(main.getByLabelText('To'), '2026-10-02');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/settings/audit?actor=${ALICE.id}&from=2026-10-01&to=2026-10-02`,
    );
    expect(asked.at(-1)).toEqual({
      actorId: ALICE.id,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-03T00:00:00.000Z',
    });
    // The last day's field only lets a day from the first on be picked.
    expect(main.getByLabelText<HTMLInputElement>('To').min).toBe('2026-10-01');
  });

  test('older entries are asked for under the same filter', async () => {
    const asked: [unknown, string | undefined][] = [];
    const view = await openAt('/w/acme/settings/audit?action=channel.created', {
      audit: (_workspace, filter, before) => {
        asked.push([filter, before]);
        return Promise.resolve(
          before === undefined ? page([anEntry(2, {})], entryId(2)) : page([anEntry(1, {})]),
        );
      },
    });
    await person().click(
      within(view.getByRole('main')).getByRole('button', { name: 'Load older' }),
    );
    await settle();
    expect(asked).toEqual([
      [{ action: 'channel.created' }, undefined],
      [{ action: 'channel.created' }, entryId(2)],
    ]);
  });

  test('a window that ends before it starts is said on its field, and nothing is asked or offered', async () => {
    let asked = 0;
    const view = await openAt('/w/acme/settings/audit?from=2026-10-31&to=2026-10-01', {
      audit: () => {
        asked += 1;
        return Promise.resolve(page([]));
      },
    });
    const main = within(view.getByRole('main'));
    expect(asked).toBe(0);
    expect(main.getByText('This day is before the first one.')).toBeDefined();
    // Nothing is loading and nothing is said to be empty: there is no list until it is put right.
    expect(view.getByRole('main').querySelector('[role="status"]')).toBeNull();
    expect(main.queryByText('No entry matches these filters.')).toBeNull();
    expect(main.queryByRole('link', { name: /Download the filtered log/ })).toBeNull();
    const offered = main.getAllByRole('button', { name: /^(CSV|NDJSON)$/ });
    expect(offered).toHaveLength(2);
    expect(offered.every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  test('downloads under the same filter, as CSV or NDJSON, from links the browser saves', async () => {
    const view = await openAt(FILTERED, { audit: () => Promise.resolve(page([])) });
    const main = within(view.getByRole('main'));
    const csv = main.getByRole('link', { name: 'Download the filtered log as CSV' });
    const ndjson = main.getByRole('link', { name: 'Download the filtered log as NDJSON' });
    expect(csv.hasAttribute('download')).toBe(true);
    const [address = '', query = ''] = (csv.getAttribute('href') ?? '').split('?');
    expect(address).toBe(`/api/workspaces/${IDS.workspace}/audit/export`);
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      actorId: ALICE.id,
      action: 'member.removed',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      format: 'csv',
    });
    expect(ndjson.getAttribute('href')).toContain('format=ndjson');
  });

  test('a download of the log is on it, said in words', async () => {
    const view = await openPage({
      audit: () =>
        Promise.resolve(page([anEntry(1, { action: 'audit.exported', targetType: 'workspace' })])),
    });
    expect(lines(view)).toEqual([`${ME.displayName} downloaded the audit log`]);
  });

  test('in Turkish, the filters and the download say so', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings/audit?action=member.left',
      locale: 'tr',
      api: aSignedInApi({ audit: () => Promise.resolve(page([])) }),
    });
    await view.findByRole('heading', { level: 1, name: 'Denetim kaydı' });
    await settle();
    const main = within(view.getByRole('main'));
    expect(main.getByLabelText<HTMLSelectElement>('İşlem').value).toBe('member.left');
    expect(main.getByRole('option', { name: 'Üye ayrıldı' })).toBeDefined();
    expect(main.getByText('Bu filtrelere uyan kayıt yok.')).toBeDefined();
    expect(main.getByRole('link', { name: 'Filtrelenmiş kaydı CSV olarak indir' })).toBeDefined();
  });
});
