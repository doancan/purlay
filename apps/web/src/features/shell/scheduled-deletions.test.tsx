/**
 * The bar of a workspace being deleted (D-242), in the real frame: one for each the person owns, saying
 * when its content goes; kept, the deletion is taken back and the session read again, which brings the
 * workspace back; refused, it says why and stays; none, no bar at all. And on the front door, when it was
 * the last workspace the person had.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { MeResponse, Workspace } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
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

const DOOMED: Workspace = {
  id: '01900000-0000-7000-8000-0000000000d1',
  name: 'Çağrı Ekibi',
  slug: 'cagri',
  avatarUrl: null,
};
const PURGE_AT = '2026-11-08T09:00:00.000Z';

const render = async (
  path: string,
  me: () => MeResponse,
  api: Partial<Api> = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path,
    api: aSignedInApi({ me: () => Promise.resolve(me()), ...api }),
  });
  await settle();
  return view;
};

const scheduled = (): MeResponse => ({
  ...aSession(),
  scheduledDeletions: [{ workspace: DOOMED, purgeAt: PURGE_AT }],
});

describe('a workspace being deleted', () => {
  test('its owner sees when it goes and keeps it; the session is read again, and the bar is gone', async () => {
    const cancelled: string[] = [];
    let reads = 0;
    const view = await render(
      '/w/acme/settings/general',
      () => {
        reads += 1;
        return cancelled.length === 0 ? scheduled() : aSession();
      },
      {
        cancelWorkspaceDeletion: (workspaceId) => {
          cancelled.push(workspaceId);
          return Promise.resolve();
        },
      },
    );
    const region = await view.findByRole('region', { name: 'Workspaces being deleted' });
    expect(region.textContent).toContain(`${DOOMED.name} is being deleted`);
    await expectNoAxeViolations(region);
    const before = reads;
    await person().click(within(region).getByRole('button', { name: `Keep ${DOOMED.name}` }));
    await settle();
    expect(cancelled).toEqual([DOOMED.id]);
    expect(reads).toBeGreaterThan(before);
    expect(view.queryByRole('region', { name: 'Workspaces being deleted' })).toBeNull();
    view.unmount();
  });

  test('a refusal is said in the bar, which stays', async () => {
    const view = await render('/w/acme/settings/general', scheduled, {
      cancelWorkspaceDeletion: () =>
        Promise.reject(new ApiError(409, 'WORKSPACE_DELETION_STARTED', 'too late')),
    });
    const region = await view.findByRole('region', { name: 'Workspaces being deleted' });
    await person().click(within(region).getByRole('button', { name: `Keep ${DOOMED.name}` }));
    await settle();
    expect(within(region).getByRole('alert').textContent).toContain(
      'The deletion was not taken back. Too late',
    );
    view.unmount();
  });

  test('nobody with nothing being deleted sees a bar', async () => {
    const view = await render('/w/acme/settings/general', aSession);
    await view.findByRole('heading', { level: 1, name: 'General' });
    expect(view.queryByRole('region', { name: 'Workspaces being deleted' })).toBeNull();
    view.unmount();
  });

  test('on the front door, when it was the last workspace, it can still be kept', async () => {
    const view = await render('/', () => ({ ...scheduled(), memberships: [] }));
    const region = await view.findByRole('region', { name: 'Workspaces being deleted' });
    expect(within(region).getByRole('button', { name: `Keep ${DOOMED.name}` })).toBeDefined();
    view.unmount();
  });
});
