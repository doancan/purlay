/**
 * A send pressed while its file is still uploading, and then left (D-171, `UX.md` §5): the person
 * moves to another channel, or closes the thread's panel, before the file lands. The send is the
 * place's, not the box's — it still goes when the upload finishes, the other person receives it with
 * its file, and the place is clean when the person comes back.
 *
 * The upload is held at the network (`page.route`) until the person has left, so "after they left"
 * is a fact of the test and not a race it hopes to win.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { navLink } from './support';

/** A 2×2 PNG: small, and a real image the API decodes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

/** Holds every upload the page starts until `release` is called; says when one has been asked for. */
const holdUploads = async (
  page: Page,
): Promise<{ readonly asked: () => number; readonly release: () => void }> => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  await page.route('**/api/workspaces/*/uploads**', async (route) => {
    asked += 1;
    await released;
    await route.continue();
  });
  return {
    asked: () => asked,
    release: (): void => {
      release();
    },
  };
};

test.describe('a send waiting on its file', () => {
  test('still goes after the person has moved to another channel, and the other person gets it with its file', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const here = await room({ members: ['dogancan', 'alice'] });
    const there = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    const uploads = await holdUploads(page);
    await page.goto(here.path);
    const box = page.getByRole('textbox', { name: `Message ${here.name}` });
    await expect(box).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect.poll(uploads.asked).toBe(1);
    await box.fill('the diagram, before I go');
    await box.press('Enter');
    await expect(page.getByText('Sends when the files finish uploading.')).toBeVisible();

    await (await navLink(page, there.name)).dispatchEvent('click');
    await expect(page.getByRole('textbox', { name: `Message ${there.name}` })).toBeVisible();
    // Not this channel's: neither its file nor its waiting is drawn here.
    await expect(page.getByText('Sends when the files finish uploading.')).toHaveCount(0);
    uploads.release();

    const alice = await asPerson('alice');
    await alice.goto(here.path);
    await expect(
      rowWith(alice, 'the diagram, before I go').getByRole('img', { name: 'diagram.png' }),
    ).toBeVisible();

    // Back where it was written: sent, so nothing waits there and the box is empty.
    await (await navLink(page, here.name)).dispatchEvent('click');
    await expect(box).toHaveValue('');
    await expect(rowWith(page, 'the diagram, before I go')).toHaveCount(1);
    await expect(page.getByRole('list', { name: 'Files' })).toHaveCount(0);
  });

  test("a reply still goes after the thread's panel is closed", async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    const question = `which diagram in ${made.name}?`;
    const root = await api('alice').say(made.id, question);
    await api('alice').say(made.id, 'the one from Monday', { parentId: root.id });
    await signIn();
    const uploads = await holdUploads(page);
    await page.goto(made.path);
    await page.getByRole('button', { name: /Open · 1 reply/ }).click();
    const thread = page.locator(`[data-thread-root="${root.id}"]`);
    const reply = thread.getByRole('textbox');
    await expect(reply).toBeVisible();

    await thread.locator('input[type="file"]').setInputFiles({
      name: 'monday.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect.poll(uploads.asked).toBe(1);
    await reply.fill('this one');
    await reply.press('Enter');
    await expect(thread.getByText('Sends when the files finish uploading.')).toBeVisible();
    await thread.getByRole('button', { name: 'Close thread' }).click();
    await expect(thread).toHaveCount(0);
    uploads.release();

    await expect
      .poll(async () => {
        const replies = await api('alice').get<{
          data: { content: string; attachments: { fileName: string }[] }[];
        }>(`/api/messages/${root.id}/thread`);
        return replies.data
          .filter((r) => r.content === 'this one')
          .map((r) => r.attachments.map((a) => a.fileName));
      })
      .toEqual([['monday.png']]);
  });
});
