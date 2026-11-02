/**
 * Deleting a workspace (D-242), against the real API: an owner asks from General's danger zone, typing its
 * name, offered the export first; the workspace leaves the owner's tab and a member's open one at once; the
 * owner keeps it from the front door, and it is back for both. Asked again and left past its grace period
 * — the row's time moved back, as a week would — the nightly job erases it, and nothing of it is offered
 * any more.
 *
 * As newcomers (`fixtures.ts`): a workspace of the test's own, since deleting the seeded one would take
 * every other test's with it.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { expect, test, workspaceFor } from './fixtures';
import { openSettings, shellReady } from './support';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '../../..');

/** The key the scratch server runs with (`scripts/demo.ts`): the job reads the same configuration. */
const DEVELOPMENT_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';

/** Moves the deletion's asking a week and a day back, as if the grace period had passed. */
const ageDeletion = async (database: string, workspaceId: string): Promise<void> => {
  await run(
    'bun',
    [
      '--no-env-file',
      '-e',
      "const [row] = await Bun.sql`update workspaces set deleted_at = deleted_at - interval '8 days' where id = ${process.env.WORKSPACE_ID} and deleted_at is not null returning id`; if (row === undefined) throw new Error('no deletion to age');",
    ],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: database, WORKSPACE_ID: workspaceId } },
  );
};

/** `bun run job purge:workspaces`, configured as the scratch server is (`scripts/demo.ts`). */
const purgeWorkspaces = async (database: string, origin: string): Promise<void> => {
  const name = new URL(database).pathname.slice(1);
  const bucket = process.env['S3_ENDPOINT'] !== undefined && process.env['S3_ENDPOINT'] !== '';
  await run('bun', ['--no-env-file', 'run', 'apps/api/src/cli/jobs.ts', 'purge:workspaces'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      APP_URL: origin,
      DATABASE_URL: database,
      GITHUB_CLIENT_ID: 'demo',
      GITHUB_CLIENT_SECRET: 'demo',
      ENCRYPTION_KEY: DEVELOPMENT_KEY,
      ...(bucket ? {} : { STORAGE_DIRECTORY: join(tmpdir(), `purlay-files-${name}`) }),
    },
  });
};

/** General's danger zone, its dialog filled in and sent. */
const askToDelete = async (page: Page, slug: string, name: string): Promise<void> => {
  const main = await openSettings(page, slug, 'general', 'General');
  await main.getByRole('button', { name: 'Delete workspace…' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Go to exports' })).toHaveAttribute(
    'href',
    `/w/${slug}/settings/data`,
  );
  const submit = dialog.getByRole('button', { name: 'Delete workspace' });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(`Type the workspace’s name, ${name}, to confirm`).fill(name);
  await expect(submit).toBeEnabled();
  await submit.click();
};

test.describe('deleting a workspace', () => {
  test('asked for, it leaves the owner and an open tab of a member at once; kept, it is back for both', async ({
    newcomer,
    expectNoAxe,
  }) => {
    const owner = await newcomer('deletes');
    const member = await newcomer('deleted-from');
    const workspace = await workspaceFor(owner, member);
    const ownerPage = await owner.page();
    const memberPage = await member.page();
    await memberPage.goto(`/w/${workspace.slug}`);
    await shellReady(memberPage);

    const main = await openSettings(ownerPage, workspace.slug, 'general', 'General');
    await main.getByRole('button', { name: 'Delete workspace…' }).click();
    await expectNoAxe(ownerPage.getByRole('dialog'));
    await ownerPage.keyboard.press('Escape');
    await askToDelete(ownerPage, workspace.slug, workspace.name);

    // The owner's last workspace: the front door, with the way to keep it.
    const bar = ownerPage.getByRole('region', { name: 'Workspaces being deleted' });
    await expect(bar).toContainText(`${workspace.name} is being deleted`);
    await expectNoAxe(bar);
    // The member's open tab is told, and has nothing there any more.
    await expect(memberPage.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
    // Their session is theirs still.
    expect((await member.api.get<{ memberships: unknown[] }>('/api/me')).memberships).toEqual([]);

    await bar.getByRole('button', { name: `Keep ${workspace.name}` }).click();
    await shellReady(ownerPage);
    await expect(ownerPage).toHaveURL(new RegExp(`/w/${workspace.slug}`));
    await memberPage.goto(`/w/${workspace.slug}`);
    await shellReady(memberPage);
  });

  test('left past its grace period, the nightly job erases it, and nothing of it is offered again', async ({
    newcomer,
    world,
    baseURL,
  }) => {
    const owner = await newcomer('erases');
    const workspace = await workspaceFor(owner);
    const page = await owner.page();
    await askToDelete(page, workspace.slug, workspace.name);
    await expect(page.getByRole('region', { name: 'Workspaces being deleted' })).toBeVisible();

    await ageDeletion(world.database, workspace.id);
    await purgeWorkspaces(world.database, baseURL ?? '');

    await page.reload();
    await expect(page.getByRole('region', { name: 'Workspaces being deleted' })).toHaveCount(0);
    const me = await owner.api.get<{ memberships: unknown[]; scheduledDeletions: unknown[] }>(
      '/api/me',
    );
    expect(me).toMatchObject({ memberships: [], scheduledDeletions: [] });
    const refused = await owner.api.del(`/api/workspaces/${workspace.id}/deletion`).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain('404');
  });
});
