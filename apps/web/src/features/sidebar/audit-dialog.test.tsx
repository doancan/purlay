/**
 * The audit trail (D-26), read in the app: who did which administrative thing to whom, newest first,
 * in words — and an action this client does not know yet said by its name, never dropped.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { AuditEntry, AuditPage, UserRole } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, ME, WHEN, aSession, aSignedInApi } from '../../testing/fixtures';
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

const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
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
  await person().click(view.getByRole('button', { name: 'Switch workspace' }));
  return view;
};

const openDialog = async (api: Partial<Api>): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await open(api);
  await person().click(view.getByRole('menuitem', { name: 'Audit log…' }));
  await settle();
  return view;
};

const lines = (view: Awaited<ReturnType<typeof renderApp>>): string[] =>
  within(view.getByRole('dialog'))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('[data-audit-line]')?.textContent ?? '');

describe('the audit log', () => {
  test('is an owner’s and an admin’s; a member is not offered it', async () => {
    const member = await open({}, 'member');
    expect(member.queryByRole('menuitem', { name: 'Audit log…' })).toBeNull();
    member.unmount();
    const admin = await open({}, 'admin');
    expect(admin.getByRole('menuitem', { name: 'Audit log…' })).toBeDefined();
  });

  test('a channel renamed is said with the name it had and the one it has (D-123)', async () => {
    const view = await openDialog({
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
    const view = await openDialog({
      audit: () =>
        Promise.resolve(
          page([anEntry(1, { action: 'channel.archived', metadata: { name: 'general' } })]),
        ),
    });
    expect(lines(view)).toEqual([`${ME.displayName} archived #general`]);
  });

  test('the nightly purge is said with what it cleared, and no person, since nobody did it (D-139 §3)', async () => {
    const view = await openDialog({
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

  test('says each action in words, with the people and the channel named', async () => {
    const view = await openDialog({
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
    await expectNoAxeViolations(view.getByRole('dialog'));
  });

  test('a repository connected to a channel and disconnected is said with the repository (D-134)', async () => {
    const view = await openDialog({
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

  test('an action this client does not know is said by its name; an erased actor or a gone channel is said as such', async () => {
    const view = await openDialog({
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
    const view = await openDialog({
      audit: (_workspace, before) => {
        asked.push(before);
        return Promise.resolve(
          before === undefined ? page([anEntry(2, {})], entryId(2)) : page([anEntry(1, {})]),
        );
      },
    });
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Load older' }),
    );
    await settle();
    expect(asked).toEqual([undefined, entryId(2)]);
    expect(lines(view)).toHaveLength(2);
    expect(
      within(view.getByRole('dialog')).queryByRole('button', { name: 'Load older' }),
    ).toBeNull();
  });

  test('empty, it says so; failing, it says why with Retry; reading, it is a status', async () => {
    const empty = await openDialog({ audit: () => Promise.resolve(page([])) });
    expect(
      within(empty.getByRole('dialog')).getByText('Nothing administrative has happened yet.'),
    ).toBeDefined();
    empty.unmount();
    let failing = true;
    const failed = await openDialog({
      audit: () =>
        failing ? Promise.reject(new ApiError(0, 'NETWORK', 'down')) : Promise.resolve(page([])),
    });
    failing = false;
    await person().click(within(failed.getByRole('dialog')).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      within(failed.getByRole('dialog')).getByText('Nothing administrative has happened yet.'),
    ).toBeDefined();
    failed.unmount();
    const reading = await openDialog({ audit: () => new Promise(() => undefined) });
    expect(reading.getByRole('dialog').querySelector('[role="status"]')).not.toBeNull();
  });
});
