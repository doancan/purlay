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
      audit: (_workspace, before) => {
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
