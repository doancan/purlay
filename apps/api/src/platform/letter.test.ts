/** The one shape every letter has: blocks as a page and as plain text, every character escaped. */
import { describe, expect, test } from 'bun:test';
import { composeLetter, type LetterParts } from './letter';

const parts = (overrides: Partial<LetterParts> = {}): LetterParts => ({
  to: 'ada@example.test',
  subject: 'A <subject>',
  locale: 'en',
  blocks: [
    { kind: 'paragraph', text: 'Hello & welcome.' },
    { kind: 'button', label: 'Do it', url: 'https://purlay.test/x#t' },
    { kind: 'note', text: 'Ignore it if you like.' },
  ],
  ...overrides,
});

describe('a letter', () => {
  test('as text: the blocks in order, the button as its words and address, signed', () => {
    const { to, subject, text } = composeLetter(parts());
    expect(to).toBe('ada@example.test');
    expect(subject).toBe('A <subject>');
    expect(text).toBe(
      'Hello & welcome.\n\nDo it:\nhttps://purlay.test/x#t\n\nIgnore it if you like.\n\n— Purlay',
    );
  });

  test('as HTML: a whole page in its language, light only, the button a link, its address again at the foot', () => {
    const { html } = composeLetter(parts());
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<title>A &lt;subject&gt;</title>');
    expect(html).toContain('Hello &amp; welcome.');
    expect(html).toContain('>Do it</a>');
    expect(html.match(/href="https:\/\/purlay\.test\/x#t"/g)).toHaveLength(2);
    expect(html).toContain('If the button does not work, paste this address into your browser:');
    expect(html).toContain('— Purlay');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<img');
  });

  test('without a button there is no address at the foot', () => {
    const { html } = composeLetter(parts({ blocks: [{ kind: 'paragraph', text: 'Only words.' }] }));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('paste this address');
  });

  test('in Turkish, the foot and a group’s links are in Turkish', () => {
    const { html, text } = composeLetter(
      parts({
        locale: 'tr',
        blocks: [
          {
            kind: 'group',
            title: '#genel — 2 mesaj',
            items: [{ text: 'Ayşe: “selam”', url: 'https://purlay.test/m1' }, { text: 'Bora' }],
            more: 've 1 tane daha',
          },
          { kind: 'button', label: 'Purlay’ı aç', url: 'https://purlay.test' },
        ],
      }),
    );
    expect(html).toContain('Düğme çalışmazsa bu adresi tarayıcına yapıştır:');
    expect(html).toContain('Ayşe: “selam” · <a href="https://purlay.test/m1"');
    expect(html).toContain('>Aç</a>');
    expect(text).toContain(
      '#genel — 2 mesaj\n  Ayşe: “selam”\n  https://purlay.test/m1\n  Bora\n  ve 1 tane daha',
    );
  });

  test('nothing in a block becomes markup: words, labels and addresses are escaped', () => {
    const { html } = composeLetter(
      parts({
        blocks: [
          { kind: 'heading', text: '<script>alert(1)</script>' },
          { kind: 'note', text: '"><img src=x>', url: 'https://purlay.test/?a="b"' },
          { kind: 'button', label: '<b>go</b>', url: 'https://purlay.test/"><x' },
        ],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://purlay.test/?a=&quot;b&quot;"');
    expect(html).toContain('href="https://purlay.test/&quot;&gt;&lt;x"');
  });
});
