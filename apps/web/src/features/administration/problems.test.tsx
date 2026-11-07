import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { ServerBackupStatus, ServerJob } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import {
  ADMIN_OVERVIEW,
  ADMIN_STAMP,
  adminError,
  adminJson,
  renderAdministration,
} from '../../testing/administration';

installDom();
const backup: ServerBackupStatus = {
  state: 'current',
  checkedAt: ADMIN_STAMP,
  backup: {
    version: 1,
    source: 'backup-script',
    completedAt: ADMIN_STAMP,
    scope: 'database',
    databaseSha256: 'a'.repeat(64),
    databaseBytes: '4096',
    maxAgeSeconds: 172800,
  },
  restore: null,
  restoreMatchesLatest: false,
};
const job: ServerJob = {
  name: 'sweep:exports',
  status: 'ok',
  lastStartedAt: ADMIN_STAMP,
  lastSuccessAt: ADMIN_STAMP,
  durationMs: 30,
  consecutiveFailures: 0,
};
const operations = (jobs: readonly ServerJob[]): Response =>
  adminJson({ checkedAt: ADMIN_STAMP, staleAfterMs: 172800000, jobs });

describe('server overview problem summary', () => {
  test('identifies failing, overdue and never-successful jobs, stale backup evidence and failed exports with actual destinations', async () => {
    const view = await renderAdministration('overview', (call) => {
      if (call.path === '/api/server/overview')
        return adminJson({ ...ADMIN_OVERVIEW, exportFailures: 3 });
      if (call.path === '/api/server/backups') return adminJson({ ...backup, state: 'stale' });
      if (call.path === '/api/server/operations')
        return operations([
          job,
          { ...job, name: 'purge:workspaces', status: 'overdue' },
          { ...job, name: 'sweep:sessions', status: 'never', lastSuccessAt: null },
          { ...job, name: 'sweep:uploads', consecutiveFailures: 2 },
        ]);
      return undefined;
    });
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(await card.findByText('Reported problems: 7')).toBeDefined();
    expect(card.queryByText('sweep:exports')).toBeNull();
    expect(card.getByText('purge:workspaces')).toBeDefined();
    expect(card.getByText('sweep:sessions')).toBeDefined();
    expect(card.getByText('sweep:uploads')).toBeDefined();
    expect(card.getByText('Failed exports: 3')).toBeDefined();
    expect(
      card
        .getAllByRole('link', { name: 'View operations' })
        .every((link) => link.getAttribute('href') === '/server/operations'),
    ).toBe(true);
    expect(card.getByRole('link', { name: 'View data management' }).getAttribute('href')).toBe(
      '/server/data',
    );
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('names the facts between modules that were given up on or wait too long, and says nothing when none do', async () => {
    const view = await renderAdministration('overview', (call) =>
      call.path === '/api/server/overview'
        ? adminJson({ ...ADMIN_OVERVIEW, outboxDeadFacts: 2, outboxOldestPendingSeconds: 1200 })
        : call.path === '/api/server/backups'
          ? adminJson(backup)
          : undefined,
    );
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(await card.findByText('Given up on after their tries: 2')).toBeDefined();
    expect(card.getByText('The oldest has waited 20 minutes')).toBeDefined();
    expect(card.getByText('Reported problems: 3')).toBeDefined();
    view.unmount();

    const quiet = await renderAdministration('overview', (call) =>
      call.path === '/api/server/overview'
        ? adminJson({ ...ADMIN_OVERVIEW, outboxOldestPendingSeconds: 900 })
        : call.path === '/api/server/backups'
          ? adminJson(backup)
          : undefined,
    );
    const clean = within(await quiet.findByRole('region', { name: 'Server problems' }));
    expect(await clean.findByText('No problems reported by these checks.')).toBeDefined();
    quiet.unmount();
  });

  test('names the dead facts alone, with no wait to report, and the wait alone, with no dead fact', async () => {
    const deadOnly = await renderAdministration('overview', (call) =>
      call.path === '/api/server/overview'
        ? adminJson({ ...ADMIN_OVERVIEW, outboxDeadFacts: 1, outboxOldestPendingSeconds: 30 })
        : call.path === '/api/server/backups'
          ? adminJson(backup)
          : undefined,
    );
    const dead = within(await deadOnly.findByRole('region', { name: 'Server problems' }));
    expect(await dead.findByText('Given up on after their tries: 1')).toBeDefined();
    expect(dead.queryByText(/has waited/)).toBeNull();
    expect(dead.getByText('Reported problems: 1')).toBeDefined();
    deadOnly.unmount();

    const waitOnly = await renderAdministration('overview', (call) =>
      call.path === '/api/server/overview'
        ? adminJson({ ...ADMIN_OVERVIEW, outboxOldestPendingSeconds: 901 })
        : call.path === '/api/server/backups'
          ? adminJson(backup)
          : undefined,
    );
    const waiting = within(await waitOnly.findByRole('region', { name: 'Server problems' }));
    expect(await waiting.findByText('The oldest has waited 15 minutes')).toBeDefined();
    expect(waiting.queryByText(/Given up on/)).toBeNull();
    waitOnly.unmount();
  });

  test.each(['unconfigured', 'unreported', 'invalid', 'stale'] as const)(
    'backup evidence state %s remains actionable',
    async (state) => {
      const view = await renderAdministration('overview', (call) =>
        call.path === '/api/server/backups' ? adminJson({ ...backup, state }) : undefined,
      );
      const card = within(await view.findByRole('region', { name: 'Server problems' }));
      expect(await card.findByText('Reported problems: 1')).toBeDefined();
      expect(card.getByRole('link', { name: 'View operations' }).getAttribute('href')).toBe(
        '/server/operations',
      );
      expect(card.queryByText('No problems reported by these checks.')).toBeNull();
      view.unmount();
    },
  );

  test('complete clean reports are scoped to these checks, use server freshness and work without optional modules', async () => {
    const view = await renderAdministration(
      'overview',
      (call) => (call.path === '/api/server/backups' ? adminJson(backup) : undefined),
      { modules: [] },
    );
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(await card.findByText('No problems reported by these checks.')).toBeDefined();
    expect(card.queryByRole('list')).toBeNull();
    expect(card.getByText(/does not prove/)).toBeDefined();
    expect(view.calls.some((call) => call.path.includes('/api/chat'))).toBe(false);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test.each(['/api/server/overview', '/api/server/operations', '/api/server/backups'])(
    'a failed read of %s cannot become an all-clear and can be retried independently',
    async (path) => {
      let fail = true;
      const view = await renderAdministration('overview', (call) => {
        if (call.path === path && fail) return adminError();
        if (call.path === '/api/server/backups') return adminJson(backup);
        return undefined;
      });
      const card = within(await view.findByRole('region', { name: 'Server problems' }));
      expect(
        await card.findByText(
          'Some checks could not be completed. Review the available results and retry.',
        ),
      ).toBeDefined();
      expect(card.getByRole('alert')).toBeDefined();
      expect(card.queryByText('No problems reported by these checks.')).toBeNull();
      fail = false;
      await person().click(card.getByRole('button', { name: 'Retry' }));
      expect(await card.findByText('No problems reported by these checks.')).toBeDefined();
      view.unmount();
    },
  );

  test('pending reports cannot claim no problems, and a completed read reveals its actual result', async () => {
    let finish: () => void = () => undefined;
    const view = await renderAdministration('overview', (call) => {
      if (call.path !== '/api/server/backups') return undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            finish = (): void => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(backup)));
              controller.close();
            };
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(card.getByText('Checking operational reports…')).toBeDefined();
    expect(card.queryByText('No problems reported by these checks.')).toBeNull();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(await card.findByText('No problems reported by these checks.')).toBeDefined();
    view.unmount();
  });

  test('a failed refresh preserves the named jobs from the last report and identifies the missing check', async () => {
    let fail = false;
    const view = await renderAdministration('overview', (call) => {
      if (call.path === '/api/server/operations')
        return fail ? adminError() : operations([{ ...job, consecutiveFailures: 1 }]);
      if (call.path === '/api/server/backups') return adminJson(backup);
      return undefined;
    });
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(await card.findByText('Reported problems: 1')).toBeDefined();
    fail = true;
    await person().click(card.getByRole('button', { name: 'Refresh' }));
    expect(await card.findByRole('alert')).toBeDefined();
    expect(card.getByText('sweep:exports')).toBeDefined();
    expect(
      card.getByText('Some checks could not be completed. Review the available results and retry.'),
    ).toBeDefined();
    expect(card.queryByText('No problems reported by these checks.')).toBeNull();
    view.unmount();
  });
  test('refresh failures suppress the previous all-clear and then recover', async () => {
    let fail = false;
    const view = await renderAdministration('overview', (call) => {
      if (call.path === '/api/server/operations') return fail ? adminError() : operations([]);
      if (call.path === '/api/server/backups') return adminJson(backup);
      return undefined;
    });
    const card = within(await view.findByRole('region', { name: 'Server problems' }));
    expect(await card.findByText('No problems reported by these checks.')).toBeDefined();
    fail = true;
    const before = view.calls.length;
    await person().click(card.getByRole('button', { name: 'Refresh' }));
    expect(await card.findByRole('alert')).toBeDefined();
    expect(card.queryByText('No problems reported by these checks.')).toBeNull();
    const reads = view.calls.slice(before).filter((call) => call.path.startsWith('/api/server/'));
    expect(new Set(reads.map((call) => call.path))).toEqual(
      new Set(['/api/server/overview', '/api/server/operations', '/api/server/backups']),
    );
    fail = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    expect(await card.findByText('No problems reported by these checks.')).toBeDefined();
    view.unmount();
  });
});
