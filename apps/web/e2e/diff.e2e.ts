/**
 * A pasted diff, the whole way (#80, D-133): sent as a ` ```diff ` block through the API, drawn as a
 * diff in a real browser — numbered lines in a table, Unified and Split on a wide window, unified
 * alone on a narrow one — and clean of contrast and role violations in both themes.
 */
import { expect, test } from './fixtures';
import { isNarrow } from './support';

const DIFF = [
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,3 +10,4 @@',
  ' const base = 1000;',
  '-const cap = 4000;',
  '+const cap = 8000;',
  '+const jitter = 0.2;',
  ' return n;',
].join('\n');

test.describe('a pasted diff', () => {
  test('is drawn as a diff, and split where there is room', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: `\`\`\`diff\n${DIFF}\n\`\`\`` }] });
    await signIn();
    await page.goto(made.path);
    const diff = page.getByRole('region', { name: 'Diff, 2 added, 1 removed' });
    await expect(diff).toBeVisible();
    await expect(diff.getByText('src/retry.ts')).toBeVisible();
    await expect(diff.locator('[data-diff-line="added"]').first()).toBeVisible();

    if (isNarrow(page)) {
      await expect(page.getByRole('button', { name: 'Split' })).toBeHidden();
    } else {
      await page.getByRole('button', { name: 'Split' }).click();
      await expect(page.getByRole('button', { name: 'Split' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(diff.locator('tbody:visible tr')).toHaveCount(5);
    }
    await expectNoAxe(diff);
  });
});
