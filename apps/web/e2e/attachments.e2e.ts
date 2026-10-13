/**
 * An attachment, the whole way (#387, D-109, D-117): picked in one browser, uploaded with its progress,
 * sent with the words, and seen as an image by the other person — through the real API, its edge, its
 * re-encoding and the directory store the harness runs on.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A 2×2 PNG, red and blue: small, and a real image the API decodes and re-encodes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

test.describe('an attachment', () => {
  test('picked, uploaded, sent with the words, and seen by the other person as an image', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'send me the diagram' }] });
    await signIn();
    await page.goto(made.path);
    const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
    await expect(composer).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const files = page.getByRole('list', { name: 'Files' });
    await expect(files.getByText('diagram.png')).toBeVisible();
    // Landed: the chip says its stored size rather than that it is uploading.
    await expect(files.getByText(/Uploading/)).toHaveCount(0);

    await composer.fill('here it is');
    await composer.press('Enter');
    await expect(
      rowWith(page, 'here it is').getByRole('img', { name: 'diagram.png' }),
    ).toBeVisible();

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    const image = rowWith(alice, 'here it is').getByRole('img', { name: 'diagram.png' });
    await expect(image).toBeVisible();
    // Drawn from the API's own re-encoding, never a public address.
    expect(await image.getAttribute('src')).toMatch(/^\/api\/attachments\/[0-9a-f-]+\/thumbnail$/);
    // Decoded, not only laid out: visible is true of an image whose bytes are still on their way,
    // and read at once its width was sometimes still 0 under the full suite's load (#347).
    await expect
      .poll(async () => await image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  });

  test('shared by one person, it appears in the other’s Files panel as it arrives (D-129)', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({ messages: [{ by: 'alice', text: 'the files are coming' }] });
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: 'Files in this channel' }).click();
    const panel = page.getByRole('complementary', { name: /^Files/ });
    await expect(panel.getByRole('heading', { name: 'No files yet' })).toBeVisible();

    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await alice.locator('input[type="file"]').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(
      alice.getByRole('list', { name: 'Files', exact: true }).getByText(/Uploading/),
    ).toHaveCount(0);
    const composer = alice.getByRole('textbox', { name: `Message ${made.name}` });
    await composer.fill('the diagram');
    await composer.press('Enter');

    // Told by the socket, read again: no reload on this side.
    await expect(panel.getByRole('link', { name: 'Open diagram.png' })).toBeVisible();
    await expect(panel.getByText('alice', { exact: false }).first()).toBeVisible();
  });
});
