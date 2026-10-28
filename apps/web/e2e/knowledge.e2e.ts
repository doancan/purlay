import { expect, test } from './fixtures';
import type { Message } from '@purlay/types';

test('a question is tracked before its first reply, keeps its decision, and is found through saved filters', async ({
  page,
  signIn,
  room,
  api,
  tenant,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice', 'bob'] });
  const root = await api('carol').say(made.id, `Retry policy ${made.name}`);
  await signIn();
  await page.goto(`${made.path}?thread=${root.id}`);
  const panel = page.locator(`[data-thread-root="${root.id}"]`);
  await panel.getByRole('button', { name: 'Edit decision' }).click();
  await panel.getByLabel('Track as a question').check();
  await panel.getByLabel('Responsible person').selectOption(tenant.userIds.dogancan);
  await panel.getByRole('button', { name: 'Save decision' }).click();
  await expect(panel.getByRole('button', { name: 'Edit decision' })).toBeVisible();
  await page.goto(`/w/${tenant.slug}/questions?show=unanswered&order=oldest`);
  await expect(
    page.getByRole('button', { name: new RegExp(`Retry policy ${made.name}`) }),
  ).toBeVisible();
  await expectNoAxe();

  const answer = await api('bob').say(
    made.id,
    `Wait four seconds for upstream capacity ${made.name}.`,
    { parentId: root.id },
  );
  await page.goto(`${made.path}?thread=${root.id}`);
  await panel.getByRole('button', { name: 'Edit decision' }).click();
  await panel.getByLabel('Selected answer').selectOption(answer.id);
  await panel.getByLabel('Decision note', { exact: true }).fill(`Avoid retry storms ${made.name}`);
  await panel.getByLabel('Related link').fill('https://github.com/acme/api/pull/42');
  await panel.getByRole('button', { name: 'Save decision' }).click();
  await expect(panel.getByText('Accepted answer', { exact: true })).toBeVisible();
  await expect(panel.getByText(`Avoid retry storms ${made.name}`, { exact: true })).toBeVisible();
  await expectNoAxe();
  await page.screenshot({ path: test.info().outputPath('question-decision.png'), fullPage: true });
  await api('carol').resolve(root.id);

  await page.goto(
    `/w/${tenant.slug}/search?q=${encodeURIComponent(made.name)}&status=resolved&question=yes&repository=acme%2Fapi`,
  );
  await expect(
    page.getByRole('button', { name: new RegExp(`Retry policy ${made.name}`) }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await page.getByLabel('Search name').fill(`Decisions ${made.name}`);
  await page.getByRole('button', { name: 'Save this search' }).click();
  await expect(
    page.getByRole('button', { name: `Decisions ${made.name}`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await page.getByRole('button', { name: `Decisions ${made.name}`, exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('resolved');
  await expect(page.getByLabel('GitHub repository')).toHaveValue('acme/api');
  await expectNoAxe();

  await api('bob').remove(answer.id);
  const current = await api('carol').get<{ data: Message[] }>(`/api/channels/${made.id}/messages`);
  expect(
    current.data.find((message) => message.id === root.id)?.thread?.knowledge?.acceptedAnswer,
  ).toBeNull();
});

test('advanced search stays usable at 320 pixels', async ({
  page,
  signIn,
  tenant,
  expectNoAxe,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await signIn();
  await page.goto(`/w/${tenant.slug}/search?question=yes`);
  await expect(page.getByLabel('Thread status')).toBeVisible();
  await page.getByLabel('Thread status').selectOption('resolved');
  await expect(page.getByRole('combobox', { name: 'Questions', exact: true })).toHaveValue('yes');
  await page.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await expect(page.getByLabel('Search name')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expectNoAxe();
  await page.screenshot({ path: test.info().outputPath('search-320.png'), fullPage: true });
});
