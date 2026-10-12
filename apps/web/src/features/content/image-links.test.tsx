/**
 * Picture links under a message (#110, `UX.md` §3): which links are drawn as pictures, through the
 * proxy and never from their own host, how many, and that one the proxy cannot show draws nothing.
 */
import { describe, expect, test } from 'bun:test';
import { fireEvent } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { IMAGE_LINKS_DRAWN, ImageLinks, pictureLinksOf } from './image-links';

installDom();

describe('picture links', () => {
  test('https links whose path is a picture’s, unique, in order — nothing else', () => {
    expect(
      pictureLinksOf(
        'see https://img.example/a.PNG and https://img.example/b.jpg?w=2, ' +
          'not http://img.example/c.png, not https://img.example/page, ' +
          'not `https://img.example/d.png`, and https://img.example/a.PNG again',
      ),
    ).toEqual(['https://img.example/a.PNG', 'https://img.example/b.jpg?w=2']);
    expect(
      pictureLinksOf('> quoted https://img.example/q.webp\n\n- listed https://img.example/l.gif'),
    ).toEqual(['https://img.example/q.webp', 'https://img.example/l.gif']);
  });

  test('found in a table and a heading; never in a code block, or past a rule', () => {
    const content = [
      '# heading https://img.example/h.png',
      '',
      '| a | b |',
      '|---|---|',
      '| https://img.example/t.png | x |',
      '',
      '```',
      'https://img.example/code.png',
      '```',
      '',
      '---',
    ].join('\n');
    expect(pictureLinksOf(content)).toEqual([
      'https://img.example/h.png',
      'https://img.example/t.png',
    ]);
  });

  test(`no more than ${String(IMAGE_LINKS_DRAWN)} per message; the rest stay links`, () => {
    const many = Array.from(
      { length: IMAGE_LINKS_DRAWN + 2 },
      (_, n) => `https://img.example/${String(n)}.png`,
    );
    expect(pictureLinksOf(many.join(' '))).toHaveLength(IMAGE_LINKS_DRAWN);
  });

  test('a picture is drawn through the proxy, as a link to the original, and described by its host', async () => {
    const view = await renderApp(<ImageLinks content="look https://img.example/cat.png" />);
    const picture = view.getByRole('img', { name: 'An image from img.example' });
    expect(picture.getAttribute('src')).toBe(
      `/api/images?url=${encodeURIComponent('https://img.example/cat.png')}`,
    );
    const link = picture.closest('a');
    expect(link?.getAttribute('href')).toBe('https://img.example/cat.png');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    await expectNoAxeViolations(view.container);
  });

  test('a picture the proxy cannot show draws nothing; words with none draw nothing', async () => {
    const view = await renderApp(<ImageLinks content="look https://img.example/gone.png" />);
    fireEvent.error(view.getByRole('img'));
    expect(view.queryByRole('img')).toBeNull();
    const none = await renderApp(<ImageLinks content="no pictures here" />);
    expect(none.container.innerHTML).toBe('');
  });

  test('is described in Turkish when the interface is', async () => {
    const view = await renderApp(<ImageLinks content="bak https://img.example/k.png" />, {
      locale: 'tr',
    });
    expect(view.getByRole('img', { name: 'img.example adresinden bir görsel' })).toBeDefined();
  });
});
