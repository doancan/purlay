/**
 * The image viewer (D-159): a thumbnail opens it in place of a new tab, on the whole window, saying
 * what the picture is, who shared it, when and how large; Download and Open original; Esc, the close
 * button and a click beside the picture close it, and focus goes back to the thumbnail; ←/→ step
 * through the message's pictures and stop at either end. A click with a key held is the browser's.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Attachment } from '@purlay/types';
import { expectNoAxeViolations } from '../../testing/axe';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { ME, aMessage } from '../../testing/fixtures';
import { expectFocusOn } from '../../testing/focus';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { MessageRow, type MessageRowProps } from './message-row';

installDom();

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

const picture = (n: number, name: string): Attachment => ({
  id: `01995f7b-0000-7000-8000-00000000000${String(n)}`,
  fileName: name,
  mimeType: 'image/webp',
  sizeBytes: 2 * 1024 * 1024,
  kind: 'image',
  width: 1600,
  height: 900,
});

const FIRST = picture(1, 'first.png');
const SECOND = picture(2, 'second.png');
const FILE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000009',
  fileName: 'notes.pdf',
  mimeType: 'application/octet-stream',
  sizeBytes: 1536,
  kind: 'file',
  width: null,
  height: null,
};

const row = (attachments: readonly Attachment[]): MessageRowProps => ({
  message: aMessage(1, { createdAt: '2026-09-09T11:55:00.000Z', attachments: [...attachments] }),
  meId: ME.id,
  nowMinute: NOW,
  members: new Map([[ME.id, 'dogancan']]),
});

const thumbnail = (view: Awaited<ReturnType<typeof renderApp>>, name: string): HTMLElement =>
  view.getByRole('link', { name: `Open ${name}` });

const openOn = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  name: string,
): Promise<HTMLElement> => {
  const link = thumbnail(view, name);
  act(() => {
    link.focus();
    fireEvent.click(link);
  });
  await settle();
  return view.getByRole('dialog');
};

describe('the image viewer', () => {
  test('a thumbnail opens it in place, saying what the picture is, who shared it, when and its size', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, SECOND, FILE])} />);
    const link = thumbnail(view, 'first.png');
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    // Still a link to the image, for a click with a key held.
    expect(link.getAttribute('href')).toBe(`/api/attachments/${FIRST.id}`);

    const dialog = await openOn(view, 'first.png');
    expect(dialog.getAttribute('aria-labelledby')).not.toBeNull();
    expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeDefined();
    const sender = aMessage(1).sender;
    expect(dialog.textContent).toContain(sender?.displayName ?? '');
    expect(dialog.textContent).toContain('2 MB');
    expect(dialog.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-09T11:55:00.000Z');

    const full = within(dialog).getByRole('img', { name: 'first.png' });
    expect(full.getAttribute('src')).toBe(`/api/attachments/${FIRST.id}`);
    const download = within(dialog).getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe(`/api/attachments/${FIRST.id}`);
    expect(download.getAttribute('download')).toBe('first.png');
    const original = within(dialog).getByRole('link', { name: 'Open original' });
    expect(original.getAttribute('target')).toBe('_blank');
    expect(original.getAttribute('rel')).toBe('noopener noreferrer');
    // The viewer itself takes the first focus, inside the dialog.
    expectFocusOn(dialog);
    await expectNoAxeViolations(dialog);
    view.unmount();
  });

  test('Esc closes it and gives focus back to the thumbnail that opened it', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, SECOND])} />);
    await openOn(view, 'second.png');
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expectFocusOn(thumbnail(view, 'second.png'));
    view.unmount();
  });

  test('the close button closes it, and so does a click beside the picture', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST])} />);
    let dialog = await openOn(view, 'first.png');
    await person().click(within(dialog).getByRole('button', { name: 'Close' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();

    dialog = await openOn(view, 'first.png');
    const stage = within(dialog)
      .getByRole('img', { name: 'first.png' })
      .closest('[style]')?.parentElement;
    if (!(stage instanceof HTMLElement)) throw new Error('no stage');
    // A click on the picture is not one beside it.
    act(() => {
      fireEvent.click(within(dialog).getByRole('img', { name: 'first.png' }));
    });
    expect(view.queryByRole('dialog')).not.toBeNull();
    act(() => {
      fireEvent.click(stage);
    });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });

  test('←/→ step through the message’s pictures, never its files, and stop at either end', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, FILE, SECOND])} />);
    const dialog = await openOn(view, 'first.png');
    expect(dialog.textContent).toContain('1 of 2');
    expect(within(dialog).queryByRole('button', { name: 'Previous image' })).toBeNull();

    await person().keyboard('{ArrowLeft}');
    expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeDefined();
    await person().keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('heading', { name: 'second.png' })).toBeDefined();
    expect(dialog.textContent).toContain('2 of 2');
    expect(within(dialog).getByRole('img', { name: 'second.png' }).getAttribute('src')).toBe(
      `/api/attachments/${SECOND.id}`,
    );
    expect(within(dialog).queryByRole('button', { name: 'Next image' })).toBeNull();
    await person().keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('heading', { name: 'second.png' })).toBeDefined();
    await person().keyboard('{ArrowLeft}');
    expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeDefined();
    await person().click(within(dialog).getByRole('button', { name: 'Next image' }));
    expect(within(dialog).getByRole('heading', { name: 'second.png' })).toBeDefined();

    await person().click(within(dialog).getByRole('button', { name: 'Previous image' }));
    expect(within(dialog).getByRole('heading', { name: 'first.png' })).toBeDefined();
    view.unmount();
  });

  test('Esc closes it at once, even with a control focused and its tooltip showing', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, SECOND])} />);
    await openOn(view, 'first.png');
    const user = person();
    await user.tab();
    await user.tab();
    await settle();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await user.keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expectFocusOn(thumbnail(view, 'first.png'));
    view.unmount();
  });

  test('Tab stays inside it', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, SECOND])} />);
    const dialog = await openOn(view, 'first.png');
    const user = person();
    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    view.unmount();
  });

  test('a picture that does not load says so, with Retry', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST])} />);
    const dialog = await openOn(view, 'first.png');
    act(() => {
      fireEvent.error(within(dialog).getByRole('img', { name: 'first.png' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toContain('The image did not load.');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    });
    expect(within(dialog).getByRole('img', { name: 'first.png' })).toBeDefined();
    view.unmount();
  });

  test('a click with a key held is left to the browser, which opens the image in a tab', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST])} />);
    // Heard after the app's own handler: whether it left the default alone, and then the test DOM is
    // kept from following the link, which it cannot.
    const prevented: boolean[] = [];
    const listen = (event: Event): void => {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener('click', listen);
    act(() => {
      fireEvent.click(thumbnail(view, 'first.png'), { metaKey: true });
      fireEvent.click(thumbnail(view, 'first.png'), { ctrlKey: true });
      fireEvent.click(thumbnail(view, 'first.png'), { button: 1 });
    });
    await settle();
    document.removeEventListener('click', listen);
    expect(prevented).toEqual([false, false, false]);
    expect(view.queryByRole('dialog')).toBeNull();
    // And a plain click is the viewer's.
    document.addEventListener('click', listen);
    act(() => {
      fireEvent.click(thumbnail(view, 'first.png'));
    });
    await settle();
    document.removeEventListener('click', listen);
    expect(prevented).toEqual([false, false, false, true]);
    expect(view.getByRole('dialog')).toBeDefined();
    view.unmount();
  });

  test('in Turkish, its controls are Turkish', async () => {
    const view = await renderApp(<MessageRow {...row([FIRST, SECOND])} />, { locale: 'tr' });
    const link = view.getByRole('link', { name: 'first.png görüntüsünü aç' });
    act(() => {
      fireEvent.click(link);
    });
    await settle();
    const dialog = view.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'İndir' })).toBeDefined();
    expect(within(dialog).getByRole('link', { name: 'Aslını aç' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Sonraki görüntü' })).toBeDefined();
    expect(dialog.textContent).toContain('1 / 2');
    view.unmount();
  });
});
