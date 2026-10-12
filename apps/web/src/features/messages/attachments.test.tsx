/**
 * What a message carries, drawn under its words (D-109 §6, #369): an image as its thumbnail in space
 * kept for it before it loads, opening the full image; a file as its name, its size and a download;
 * nothing at all on a tombstone. A thumbnail that does not load says so, with Retry.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Attachment } from '@purlay/types';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ME, aMessage } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { MessageRow, type MessageRowProps } from './message-row';

installDom();

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

const IMAGE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000001',
  fileName: 'Ekran görüntüsü.png',
  mimeType: 'image/webp',
  sizeBytes: 48_000,
  kind: 'image',
  width: 1600,
  height: 900,
};

const FILE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000002',
  fileName: 'notes.pdf',
  mimeType: 'application/octet-stream',
  sizeBytes: 1536,
  kind: 'file',
  width: null,
  height: null,
};

const row = (over: Parameters<typeof aMessage>[1] = {}): MessageRowProps => ({
  message: aMessage(1, { createdAt: '2026-09-09T11:55:00.000Z', ...over }),
  meId: ME.id,
  nowMinute: NOW,
  members: new Map([[ME.id, 'dogancan']]),
});

describe('a message’s attachments', () => {
  test('an image is its thumbnail, in its own shape, opening the full image; a file is a download', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [IMAGE, FILE] })} />);
    const thumbnail = view.getByRole('img', { name: 'Ekran görüntüsü.png' });
    expect(thumbnail.getAttribute('src')).toBe(`/api/attachments/${IMAGE.id}/thumbnail`);
    // Its space is kept before it loads: the shape is the image's own.
    expect(thumbnail.getAttribute('style')).toContain('aspect-ratio: 1600 / 900');
    expect(thumbnail.closest('a')?.getAttribute('href')).toBe(`/api/attachments/${IMAGE.id}`);

    const download = view.getByRole('link', { name: /notes\.pdf/ });
    expect(download.getAttribute('href')).toBe(`/api/attachments/${FILE.id}`);
    expect(download.hasAttribute('download')).toBe(true);
    expect(download.textContent).toContain('1.5 kB');
    await expectNoAxeViolations(view.container);
  });

  test('in Turkish, the size and the words are Turkish', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [FILE] })} />, {
      locale: 'tr',
    });
    const download = view.getByRole('link', { name: /notes\.pdf/ });
    expect(download.textContent).toContain('1,5 kB');
    expect(download.getAttribute('aria-label')).toContain('İndir');
  });

  test('a thumbnail that does not load says so, and Retry asks for it again', async () => {
    const view = await renderApp(<MessageRow {...row({ attachments: [IMAGE] })} />);
    act(() => {
      fireEvent.error(view.getByRole('img', { name: 'Ekran görüntüsü.png' }));
    });
    expect(view.queryByRole('img', { name: 'Ekran görüntüsü.png' })).toBeNull();
    expect(view.getByText('The image did not load.')).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    });
    expect(view.getByRole('img', { name: 'Ekran görüntüsü.png' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('a deleted message draws none of them, though the cache may still hold them', async () => {
    const view = await renderApp(
      <MessageRow
        {...row({ attachments: [IMAGE, FILE], deletedAt: '2026-09-09T11:58:00.000Z' })}
      />,
    );
    expect(view.queryByRole('img')).toBeNull();
    expect(view.queryByRole('link', { name: /notes\.pdf/ })).toBeNull();
  });

  test('a message without any draws no list', async () => {
    const view = await renderApp(<MessageRow {...row()} />);
    expect(view.queryByRole('list', { name: 'Attachments' })).toBeNull();
  });
});
