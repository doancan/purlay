/**
 * Two workspaces of one server, one granted chat and issues and one chat alone (D-289, D-292), in a real browser against
 * the real API: the operator withholds issues from a workspace in the administration console, and a member who has that
 * workspace open loses the Issues place without reloading, its address answers as a page nobody has, the session lists the
 * grant per workspace, and the other workspace keeps everything. Granting it again brings the place back.
 *
 * As newcomers (`fixtures.ts`): the operator is made a server administrator in the scratch database, as the first person
 * through the setup wizard would be, and writes the grant through the console's own dialog.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { expect, test, type Newcomer } from './fixtures';
import { railLink, shellReady } from './support';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '../../..');

interface Workspace {
  readonly id: string;
  readonly slug: string;
}

const makeServerAdministrator = async (database: string, userId: string): Promise<void> => {
  await run(
    'bun',
    [
      '--no-env-file',
      '-e',
      'const [row] = await Bun.sql`update users set is_server_admin = true where id = ${process.env.USER_ID} returning id`; if (row === undefined) throw new Error("no such user");',
    ],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: database, USER_ID: userId } },
  );
};

const joinedBy = async (owner: Newcomer, member: Newcomer, workspace: Workspace): Promise<void> => {
  const { token } = await owner.api.post<{ token: string }>(
    `/api/workspaces/${workspace.id}/invitations`,
  );
  await member.api.post('/api/invitations/accept', { token });
};

/** What the session says each workspace may use, by slug, as the page itself would read it. */
const grantsInSession = async (page: Page): Promise<Record<string, readonly string[]>> =>
  await page.evaluate(async () => {
    const response = await fetch('/api/me');
    const me = (await response.json()) as {
      memberships: { workspace: { slug: string }; modules?: string[] }[];
    };
    return Object.fromEntries(
      me.memberships.map((membership) => [membership.workspace.slug, membership.modules ?? []]),
    );
  });

const statusOf = async (page: Page, path: string): Promise<number> =>
  await page.evaluate(async (target) => (await fetch(target)).status, path);

/** Opens the console's module dialog of one workspace, sets issues, saves, and waits for the dialog to close. */
const setIssues = async (
  page: Page,
  workspaceName: string,
  state: 'Granted' | 'Withheld' | 'The server’s default',
): Promise<void> => {
  await page.goto('/server/workspaces');
  const card = page.getByRole('region', { name: workspaceName });
  await card.getByRole('button', { name: 'Modules' }).click();
  const dialog = page.getByRole('dialog', { name: 'Modules' });
  await dialog.getByLabel('issues').selectOption({ label: state });
  await dialog.getByRole('button', { name: 'Save modules' }).click();
  await expect(dialog).toHaveCount(0);
};

test.describe('a workspace is granted the modules it may use', () => {
  test('the place, the address and the session follow each workspace’s grant, live, and the other workspace keeps its own', async ({
    newcomer,
    world,
  }) => {
    const operator = await newcomer('grants-op');
    const member = await newcomer('grants-mem');
    await makeServerAdministrator(world.database, operator.userId);

    const suffix = operator.username.slice(-8);
    const make = async (kind: string): Promise<Workspace & { name: string }> => {
      const name = `${kind}-${suffix}`;
      const made = await operator.api.post<Workspace>('/api/workspaces', { name, slug: name });
      await joinedBy(operator, member, made);
      return { ...made, name };
    };
    const full = await make('full');
    const chatOnly = await make('chat-only');

    const memberPage = await member.page();
    await memberPage.goto(`/w/${chatOnly.slug}`);
    await shellReady(memberPage);
    const issuesPlace = await railLink(memberPage, 'Issues');
    await expect(issuesPlace).toBeVisible();
    expect(await grantsInSession(memberPage)).toMatchObject({
      [full.slug]: ['chat', 'issues'],
      [chatOnly.slug]: ['chat', 'issues'],
    });

    // The operator withholds issues from one workspace, through the console.
    const operatorPage = await operator.page();
    await setIssues(operatorPage, chatOnly.name, 'Withheld');

    // The member's open page is told (WORKSPACE_UPDATED) and draws no Issues place, without a reload.
    await expect(issuesPlace).toHaveCount(0);
    expect(await grantsInSession(memberPage)).toMatchObject({
      [full.slug]: ['chat', 'issues'],
      [chatOnly.slug]: ['chat'],
    });

    // Its address is a page nobody has, and the API answers as for a path nobody has; the other workspace is served.
    await memberPage.goto(`/w/${chatOnly.slug}/issues`);
    await expect(memberPage.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    expect(await statusOf(memberPage, `/api/workspaces/${chatOnly.id}/issues`)).toBe(404);
    expect(await statusOf(memberPage, `/api/workspaces/${full.id}/issues`)).toBe(200);
    await memberPage.goto(`/w/${full.slug}/issues`);
    await expect(memberPage.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
    await expect(await railLink(memberPage, 'Issues')).toBeVisible();

    // Chat, which is not a grant, is still there in the workspace that lost issues.
    await memberPage.goto(`/w/${chatOnly.slug}`);
    await shellReady(memberPage);
    await expect(await railLink(memberPage, 'Search')).toBeVisible();

    // A grant given back brings the place back, to the page that is open.
    await setIssues(operatorPage, chatOnly.name, 'The server’s default');
    await expect(await railLink(memberPage, 'Issues')).toBeVisible();
    expect(await statusOf(memberPage, `/api/workspaces/${chatOnly.id}/issues`)).toBe(200);
    expect(await grantsInSession(memberPage)).toMatchObject({
      [chatOnly.slug]: ['chat', 'issues'],
    });
  });
});
