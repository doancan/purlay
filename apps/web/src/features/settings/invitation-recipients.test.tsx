import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { InvitationRecipient, InvitationDeliveryPage } from '@purlay/types';
import type { Api } from '../../data/api';
import { keys } from '../../data/keys';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { aSignedInApi, IDS } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
installDom();
const ID = '01a0860a-0a00-75f1-9438-ca8bd4a21ae5';
const row = (patch: Partial<InvitationRecipient> = {}): InvitationRecipient => ({
  id: ID,
  address: 'ann@example.test',
  createdAt: '2026-09-01T12:00:00.000Z',
  requestedAt: null,
  joinedAt: null,
  admission: null,
  latest: {
    id: ID,
    createdAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2099-09-08T12:00:00.000Z',
    revokedAt: null,
    result: 'accepted',
    finishedAt: '2026-09-01T12:00:01.000Z',
    failure: null,
  },
  ...patch,
});
const render = async (api: Partial<Api>): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/invitations',
    api: aSignedInApi({
      invitations: () => Promise.resolve({ data: [], nextCursor: null }),
      invitationRecipients: () => Promise.resolve({ data: [], nextCursor: null }),
      ...api,
    }),
  });
  await view.findByRole('heading', { level: 1, name: 'Invitations' });
  return view;
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('private invitation history', () => {
  test('loading, read failure, retry and empty remain distinct', async () => {
    let complete: (value: { data: InvitationRecipient[]; nextCursor: null }) => void = () =>
      undefined;
    const loading = await render({
      invitationRecipients: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const card = within(loading.getByRole('region', { name: 'Email invitations' }));
    expect(card.getByRole('status')).toBeDefined();
    await act(async () => {
      complete({ data: [], nextCursor: null });
      await Promise.resolve();
    });
    expect(await card.findByText('No email invitations yet.')).toBeDefined();
    loading.unmount();
    let fail = true;
    const view = await render({
      invitationRecipients: () =>
        fail
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ data: [], nextCursor: null }),
    });
    expect(await view.findByText('Could not refresh invitation history.')).toBeDefined();
    fail = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('No email invitations yet.')).toBeDefined();
    view.unmount();
  });

  test.each([
    [row(), 'Accepted by mail server'],
    [row({ admission: 'pending' }), 'Awaiting account approval'],
    [row({ admission: 'approved' }), 'Account approved; invitation not yet accepted'],
    [row({ admission: 'denied' }), 'Account not approved'],
    [row({ joinedAt: '2026-09-02T12:00:00.000Z' }), 'Invitation accepted'],
    [row({ latest: { ...row().latest, revokedAt: '2026-09-02T12:00:00.000Z' } }), 'Link revoked'],
    [row({ latest: { ...row().latest, expiresAt: '2001-01-01T00:00:00.000Z' } }), 'Link expired'],
    [row({ latest: { ...row().latest, result: 'queued', finishedAt: null } }), 'Sending'],
    [
      row({ latest: { ...row().latest, result: 'unknown', finishedAt: null } }),
      'Send result unconfirmed; you can resend',
    ],
  ] as const)('shows evidence rather than claiming inbox delivery: %s', async (value, label) => {
    const view = await render({
      invitationRecipients: () => Promise.resolve({ data: [value], nextCursor: null }),
    });
    expect(await view.findByText('ann@example.test')).toBeDefined();
    expect(
      within(view.getByRole('list', { name: 'Email invitations' })).getByRole('status').textContent,
    ).toBe(label);
    if (value.joinedAt !== null || value.latest.result === 'queued')
      expect(view.getByRole('button', { name: 'Resend' }).hasAttribute('disabled')).toBe(true);
    view.unmount();
  });

  test('failed send can be resent, then revoked; failed writes remain retryable and history pages independently', async () => {
    let value = row({ latest: { ...row().latest, result: 'failed', failure: 'recipient' } });
    let failed = true;
    let resends = 0;
    let revokes = 0;
    let historyFailed = true;
    const view = await render({
      invitationRecipients: () => Promise.resolve({ data: [value], nextCursor: null }),
      resendInvitationRecipient: () => {
        resends++;
        if (failed) return Promise.reject(new Error('offline'));
        value = row();
        return Promise.resolve();
      },
      revokeInvitationRecipient: () => {
        revokes++;
        value = row({ latest: { ...row().latest, revokedAt: '2026-09-02T12:00:00.000Z' } });
        return Promise.resolve();
      },
      invitationDeliveries: (_workspace, _recipient, before) => {
        if (historyFailed) return Promise.reject(new Error('offline'));
        return Promise.resolve({
          data: [
            before === undefined
              ? row().latest
              : { ...row().latest, id: ID + 'a', result: 'failed', failure: 'connection' },
          ],
          nextCursor: before === undefined ? ID : null,
        });
      },
    });
    expect(await view.findByText('The mail server refused the recipient.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Resend' }));
    expect(await view.findByRole('alert')).toBeDefined();
    failed = false;
    await person().click(view.getByRole('button', { name: 'Resend' }));
    expect(resends).toBe(2);
    await person().click(view.getByRole('button', { name: 'Revoke' }));
    expect(revokes).toBe(1);
    await person().click(view.getByRole('button', { name: 'Send history' }));
    expect(await view.findByText('Could not refresh invitation history.')).toBeDefined();
    historyFailed = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await person().click(await view.findByRole('button', { name: 'Load older links' }));
    expect(await view.findByText('The mail server could not be reached.')).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: 'Send history' }));
    expect(view.queryByText('The mail server could not be reached.')).toBeNull();
    view.unmount();
  });

  test('recipient pagination and history loading preserve the current rows during a failed refresh', async () => {
    const value = row();
    let finish: (page: InvitationDeliveryPage) => void = () => undefined;
    let fail = false;
    const view = await render({
      invitationRecipients: (_workspace, before) =>
        fail
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              data: [{ ...value, id: before === undefined ? ID : ID + 'a' }],
              nextCursor: before === undefined ? ID : null,
            }),
      invitationDeliveries: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await view.findByText('ann@example.test');
    await person().click(view.getByRole('button', { name: 'Send history' }));
    await act(async () => {
      finish({ data: [value.latest], nextCursor: null });
      await Promise.resolve();
    });
    await person().click(view.getByRole('button', { name: 'Load older links' }));
    expect(view.getAllByText('ann@example.test')).toHaveLength(2);
    fail = true;
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.invitationRecipients(IDS.workspace),
      });
    });
    await settle();
    expect(await view.findByText('Could not refresh invitation history.')).toBeDefined();
    expect(view.getAllByText('ann@example.test')).toHaveLength(2);
    view.unmount();
  });
});
