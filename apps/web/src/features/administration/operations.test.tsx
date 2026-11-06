import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { ServerBackupStatus, ServerMailStatus, ServerOperations } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import {
  ADMIN_OVERVIEW,
  ADMIN_SETTINGS,
  ADMIN_STAMP,
  adminError,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('administration operational evidence', () => {
  test('jobs show never, overdue and successful runs from the server and refresh on request', async () => {
    const operations: ServerOperations = {
      checkedAt: ADMIN_STAMP,
      staleAfterMs: 172800000,
      jobs: [
        {
          name: 'sweep:sessions',
          status: 'never',
          lastStartedAt: null,
          lastSuccessAt: null,
          durationMs: null,
          consecutiveFailures: 0,
        },
        {
          name: 'purge:workspaces',
          status: 'overdue',
          lastStartedAt: ADMIN_STAMP,
          lastSuccessAt: ADMIN_STAMP,
          durationMs: 200,
          consecutiveFailures: 2,
        },
        {
          name: 'sweep:exports',
          status: 'ok',
          lastStartedAt: ADMIN_STAMP,
          lastSuccessAt: ADMIN_STAMP,
          durationMs: 30,
          consecutiveFailures: 0,
        },
      ],
    };
    const view = await renderAdministration('operations', (call) =>
      call.path === '/api/server/operations' ? adminJson(operations) : undefined,
    );
    const card = within(await view.findByRole('region', { name: 'Scheduled jobs' }));
    expect(await card.findByText('Needs attention')).toBeDefined();
    expect(card.getByText('Up to date')).toBeDefined();
    expect(card.getAllByText(/Never succeeded/).length).toBeGreaterThan(0);
    const before = view.calls.filter((call) => call.path === '/api/server/operations').length;
    await person().click(card.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(view.calls.filter((call) => call.path === '/api/server/operations').length).toBe(
      before + 1,
    );
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test.each(['unconfigured', 'unreported', 'invalid', 'stale', 'current'] as const)(
    'backup state %s is reported without inventing recovery success',
    async (state) => {
      const status: ServerBackupStatus = {
        state,
        checkedAt: ADMIN_STAMP,
        backup:
          state === 'current' || state === 'stale'
            ? {
                version: 1,
                source: 'backup-script',
                completedAt: ADMIN_STAMP,
                scope: 'database-and-attachments',
                databaseSha256: 'a'.repeat(64),
                databaseBytes: '4096',
                maxAgeSeconds: 172800,
              }
            : null,
        restore: null,
        restoreMatchesLatest: false,
      };
      const view = await renderAdministration('operations', (call) =>
        call.path === '/api/server/backups' ? adminJson(status) : undefined,
      );
      const card = within(
        await view.findByRole('region', { name: 'Backup and recovery evidence' }),
      );
      expect(await card.findByText('No completed restore check has been reported.')).toBeDefined();
      if (status.backup !== null)
        expect(card.getByText(status.backup.databaseSha256)).toBeDefined();
      await person().click(card.getByRole('button', { name: 'Refresh' }));
      await settle();
      expect(
        view.calls.filter((call) => call.path === '/api/server/backups').length,
      ).toBeGreaterThan(1);
      view.unmount();
    },
  );
  test.each([true, false])(
    'restore evidence matches latest artifact and scope: %s',
    async (matches) => {
      const status: ServerBackupStatus = {
        state: 'current',
        checkedAt: ADMIN_STAMP,
        backup: {
          version: 1,
          source: 'dockhand',
          completedAt: ADMIN_STAMP,
          scope: 'database',
          databaseSha256: 'a'.repeat(64),
          databaseBytes: '4096',
          maxAgeSeconds: 7500,
        },
        restore: {
          version: 1,
          source: 'restore-script',
          checkedAt: ADMIN_STAMP,
          scope: 'database',
          databaseSha256: (matches ? 'a' : 'b').repeat(64),
        },
        restoreMatchesLatest: matches,
      };
      const view = await renderAdministration('operations', (call) =>
        call.path === '/api/server/backups' ? adminJson(status) : undefined,
      );
      expect(
        await view.findByText(
          matches
            ? 'A restore of this reported artifact and its included data completed with archive checks.'
            : 'The last restore check covers a different artifact or a smaller data scope.',
        ),
      ).toBeDefined();
      view.unmount();
    },
  );
  test('deployment inventory distinguishes absent and configured capabilities, and disabled chat hides its GitHub app', async () => {
    const view = await renderAdministration(
      'integrations',
      (call) =>
        call.path === '/api/server/overview'
          ? adminJson({
              ...ADMIN_OVERVIEW,
              pushConfigured: true,
              sharedStateConfigured: true,
              modules: [],
              storage: 'unconfigured',
            })
          : undefined,
      { modules: [] },
    );
    expect(
      await view.findByText(
        'The chat module is disabled. Its GitHub integration is unavailable on this deployment.',
      ),
    ).toBeDefined();
    expect(await view.findAllByText('Configured; delivery not tested here')).toHaveLength(2);
    expect(view.queryByRole('region', { name: 'GitHub App' })).toBeNull();
    view.unmount();
  });
  test('identity and integration providers are grouped on their actual sections', async () => {
    for (const section of ['security', 'integrations'] as const) {
      const view = await renderAdministration(section);
      expect(
        await view.findByRole('region', {
          name: section === 'security' ? 'New account admission' : 'GitHub App for issues',
        }),
      ).toBeDefined();
      view.unmount();
    }
  });
  test('saved mail sends no credentials, persists relay acceptance and reports failed attempts without losing the last receipt', async () => {
    let tests = 0;
    const settings = {
      ...ADMIN_SETTINGS,
      settings: {
        ...ADMIN_SETTINGS.settings,
        smtp: {
          address: { set: true as const, host: 'smtp://mail.test:587' },
          from: 'mail@example.test',
          allowPlaintext: false,
        },
      },
    };
    const receipt = { testedAt: ADMIN_STAMP, accepted: true, host: 'mail.test:587', reason: null };
    const view = await renderAdministration(
      'email',
      (call) => {
        if (call.path === '/api/server/mail-test' && call.method === 'POST') {
          tests++;
          expect(call.body).toEqual({});
          return tests === 1 ? adminJson(receipt) : adminError();
        }
        return undefined;
      },
      { settings },
    );
    const card = within(await view.findByRole('region', { name: 'Test saved mail configuration' }));
    expect(await card.findByText('No saved-configuration test has been recorded.')).toBeDefined();
    await person().click(card.getByRole('button', { name: 'Send test email' }));
    expect(
      await card.findByText(
        'The relay accepted this test message. Check your inbox and spam folder.',
      ),
    ).toBeDefined();
    await person().click(card.getByRole('button', { name: 'Send test email' }));
    expect(await card.findByRole('alert')).toBeDefined();
    expect(
      card.getByText('The relay accepted this test message. Check your inbox and spam folder.'),
    ).toBeDefined();
    view.unmount();
  });
  test('a refused relay test is not reported as inbox delivery, and an unconfigured relay cannot be tested', async () => {
    const status: ServerMailStatus = {
      lastTest: {
        testedAt: ADMIN_STAMP,
        accepted: false,
        host: 'mail.test:587',
        reason: 'unreachable',
      },
    };
    const view = await renderAdministration('email', (call) =>
      call.path === '/api/server/mail-test' ? adminJson(status) : undefined,
    );
    expect(
      await view.findByText('The relay did not accept the test. Review the connection settings.'),
    ).toBeDefined();
    expect(view.getByRole('button', { name: 'Send test email' }).hasAttribute('disabled')).toBe(
      true,
    );
    view.unmount();
  });
});
