import { describe, expect, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type {
  InvitationRecipient,
  InvitationDeliveryPage,
  InvitationRecipientQuery,
} from '@purlay/types';
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
  status: 'accepted',
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
const render = async (
  api: Partial<Api>,
  path = '/w/acme/settings/invitations',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path,
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
  test('a guest recipient retains its invitation kind and access expiry in delivery tracking', async () => {
    const view = await render({
      invitationRecipients: () =>
        Promise.resolve({
          data: [row({ guest: { channelCount: 1, accessExpiresAt: '2099-09-08T12:00:00.000Z' } })],
          nextCursor: null,
        }),
    });
    expect(await view.findByText('Guest invitation · 1 conversation')).toBeDefined();
    expect((await view.findByText(/Guest access ends/)).textContent).toContain('2099');
    await expectNoAxeViolations(view.container);
  });

  test('a failed filtered read keeps its fields and Retry, without offering actions for the previous results', async () => {
    let fail = true;
    const view = await render({
      invitationRecipients: (_workspace, query = {}) =>
        query.q === 'other'
          ? fail
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({ data: [], nextCursor: null })
          : Promise.resolve({ data: [row()], nextCursor: null }),
    });
    const card = within(view.getByRole('region', { name: 'Email invitations' }));
    await card.findByText('ann@example.test');
    await person().type(card.getByLabelText('Search email addresses'), 'other');
    await person().click(card.getByRole('button', { name: 'Search recipients' }));
    expect(await card.findByText('Could not refresh invitation history.')).toBeDefined();
    expect(card.queryByText('ann@example.test')).toBeNull();
    expect(card.queryByRole('button', { name: 'Resend' })).toBeNull();
    expect(card.getByLabelText<HTMLInputElement>('Search email addresses').value).toBe('other');
    fail = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    expect(await card.findByText('No invitations match these filters.')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });
  test('search and status travel to the server and the address, with separate pagination and no-match feedback', async () => {
    const asked: InvitationRecipientQuery[] = [];
    const failed = row({
      status: 'failed',
      latest: { ...row().latest, result: 'failed', failure: 'recipient' },
    });
    const view = await render(
      {
        invitationRecipients: (_workspace, query = {}) => {
          asked.push(query);
          return Promise.resolve({
            data:
              query.q === 'missing'
                ? []
                : [{ ...failed, id: query.before === undefined ? ID : ID + 'a' }],
            nextCursor: query.before === undefined && query.q !== 'missing' ? ID : null,
          });
        },
      },
      '/w/acme/settings/invitations?q=ann&status=failed',
    );
    const card = within(view.getByRole('region', { name: 'Email invitations' }));
    expect(await card.findByText('ann@example.test')).toBeDefined();
    expect(card.getByLabelText<HTMLInputElement>('Search email addresses').value).toBe('ann');
    expect(card.getByLabelText<HTMLSelectElement>('Invitation status').value).toBe('failed');
    expect(asked.at(-1)).toEqual({ q: 'ann', status: 'failed' });
    await person().click(card.getByRole('button', { name: 'Load older links' }));
    await waitFor(() => {
      expect(asked.at(-1)).toEqual({ q: 'ann', status: 'failed', before: ID });
    });
    await person().clear(card.getByLabelText('Search email addresses'));
    await person().type(card.getByLabelText('Search email addresses'), 'missing');
    await person().click(card.getByRole('button', { name: 'Search recipients' }));
    expect(await card.findByText('No invitations match these filters.')).toBeDefined();
    expect(card.queryByText('No email invitations yet.')).toBeNull();
    expect(asked.at(-1)).toEqual({ q: 'missing', status: 'failed' });
    expect(view.world.history.stack.at(-1)).toBe(
      '/w/acme/settings/invitations?q=missing&status=failed',
    );
    await act(async () => {
      view.world.history.back();
      await Promise.resolve();
    });
    expect(card.getByLabelText<HTMLInputElement>('Search email addresses').value).toBe('ann');
    await person().click(card.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(asked.at(-1)).toEqual({});
    });
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings/invitations');
    await person().selectOptions(card.getByLabelText('Invitation status'), 'pending');
    await person().click(card.getByRole('button', { name: 'Search recipients' }));
    await waitFor(() => {
      expect(asked.at(-1)).toEqual({ status: 'pending' });
    });
    await person().selectOptions(card.getByLabelText('Invitation status'), '');
    await person().click(card.getByRole('button', { name: 'Search recipients' }));
    await waitFor(() => {
      expect(card.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    });
    view.unmount();
  });
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
    [row({ status: 'pending', admission: 'pending' }), 'Awaiting account approval'],
    [
      row({ status: 'approved', admission: 'approved' }),
      'Account approved; invitation not yet accepted',
    ],
    [row({ status: 'denied', admission: 'denied' }), 'Account not approved'],
    [row({ status: 'joined', joinedAt: '2026-09-02T12:00:00.000Z' }), 'Invitation accepted'],
    [
      row({
        status: 'revoked',
        latest: { ...row().latest, revokedAt: '2026-09-02T12:00:00.000Z' },
      }),
      'Link revoked',
    ],
    [
      row({
        status: 'expired',
        latest: { ...row().latest, expiresAt: '2001-01-01T00:00:00.000Z' },
      }),
      'Link expired',
    ],
    [
      row({ status: 'queued', latest: { ...row().latest, result: 'queued', finishedAt: null } }),
      'Sending',
    ],
    [
      row({ status: 'unknown', latest: { ...row().latest, result: 'unknown', finishedAt: null } }),
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
    let value = row({
      status: 'failed',
      latest: { ...row().latest, result: 'failed', failure: 'recipient' },
    });
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
        value = row({
          status: 'revoked',
          latest: { ...row().latest, revokedAt: '2026-09-02T12:00:00.000Z' },
        });
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
      invitationRecipients: (_workspace, { before } = {}) =>
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

  test('an open history follows a send completed after it opened, keeping its older pages', async () => {
    let value = row({ latest: { ...row().latest, result: 'queued', finishedAt: null } });
    const older = {
      ...row().latest,
      id: ID + 'a',
      result: 'failed' as const,
      failure: 'connection' as const,
    };
    const view = await render({
      invitationRecipients: () => Promise.resolve({ data: [value], nextCursor: null }),
      invitationDeliveries: (_workspace, _recipient, before) =>
        Promise.resolve({
          data: [before === undefined ? value.latest : older],
          nextCursor: before === undefined ? ID : null,
        }),
    });
    await view.findByText('ann@example.test');
    await person().click(view.getByRole('button', { name: 'Send history' }));
    await person().click(await view.findByRole('button', { name: 'Load older links' }));
    expect(await view.findByText('The mail server could not be reached.')).toBeDefined();
    expect(view.getAllByText(/^Sending ·/)).toHaveLength(2);

    value = row();
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.invitationRecipients(IDS.workspace),
      });
    });

    const list = within(view.getByRole('list', { name: 'Email invitations' }));
    await waitFor(() => {
      expect(list.getByRole('status').textContent).toBe('Accepted by mail server');
      expect(list.queryAllByText(/^Sending ·/)).toHaveLength(0);
      expect(list.getAllByText(/^Accepted by mail server ·/)).toHaveLength(2);
    });
    expect(list.getByText('The mail server could not be reached.')).toBeDefined();
    view.unmount();
  });

  test('a closed history waits until reopened, while a failed automatic refresh preserves its rows and offers Retry', async () => {
    let value = row();
    let reads = 0;
    let failed = false;
    const view = await render({
      invitationRecipients: () => Promise.resolve({ data: [value], nextCursor: null }),
      invitationDeliveries: () => {
        reads++;
        return failed
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ data: [value.latest], nextCursor: null });
      },
    });
    await view.findByText('ann@example.test');
    expect(reads).toBe(0);
    const history = view.getByRole('button', { name: 'Send history' });
    await person().click(history);
    await waitFor(() => {
      expect(reads).toBe(1);
    });
    await person().click(history);

    value = row({
      status: 'revoked',
      latest: { ...row().latest, revokedAt: '2026-09-02T12:00:00.000Z' },
    });
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.invitationRecipients(IDS.workspace),
      });
    });
    await waitFor(() => {
      expect(view.getByRole('list', { name: 'Email invitations' }).textContent).toContain(
        'Link revoked',
      );
    });
    expect(reads).toBe(1);
    await person().click(history);
    await waitFor(() => {
      expect(
        within(view.getByRole('list', { name: 'Email invitations' })).getAllByText('Link revoked'),
      ).toHaveLength(3);
    });
    expect(reads).toBe(2);

    failed = true;
    value = row({
      status: 'failed',
      latest: { ...row().latest, id: ID + 'b', result: 'failed', failure: 'recipient' },
    });
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.invitationRecipients(IDS.workspace),
      });
    });
    expect(await view.findByText('Could not refresh invitation history.')).toBeDefined();
    expect(
      within(view.getByRole('list', { name: 'Email invitations' })).getByText('Link revoked'),
    ).toBeDefined();
    failed = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(view.queryByText('Could not refresh invitation history.')).toBeNull();
      expect(
        within(view.getByRole('list', { name: 'Email invitations' })).queryByText('Link revoked'),
      ).toBeNull();
      expect(view.getAllByText('The mail server refused the recipient.')).toHaveLength(2);
    });
    view.unmount();
  });

  test('a delayed first history read cannot hide the receipt that arrived while it was loading', async () => {
    let value = row({ latest: { ...row().latest, result: 'queued', finishedAt: null } });
    const queued = value.latest;
    let complete: (page: InvitationDeliveryPage) => void = () => undefined;
    let reads = 0;
    const view = await render({
      invitationRecipients: () => Promise.resolve({ data: [value], nextCursor: null }),
      invitationDeliveries: () => {
        reads++;
        return reads === 1
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : Promise.resolve({ data: [value.latest], nextCursor: null });
      },
    });
    await view.findByText('ann@example.test');
    await person().click(view.getByRole('button', { name: 'Send history' }));
    expect(reads).toBe(1);
    value = row();
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.invitationRecipients(IDS.workspace),
      });
    });
    const list = within(view.getByRole('list', { name: 'Email invitations' }));
    await waitFor(() => {
      expect(list.getAllByText(/^Accepted by mail server ·/)).toHaveLength(2);
    });
    await act(async () => {
      complete({ data: [queued], nextCursor: null });
      await Promise.resolve();
    });
    expect(list.queryAllByText(/^Sending ·/)).toHaveLength(0);
    expect(list.getAllByText(/^Accepted by mail server ·/)).toHaveLength(2);
    view.unmount();
  });
});
