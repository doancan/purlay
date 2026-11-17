import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '@purlay/markdown';
import { insertLink } from './link-text';

describe('links inserted by the composer', () => {
  test.each(['javascript:alert(1)', 'data:text/html,x', '/relative', '//example.com', 'not a URL'])(
    'refuses %s',
    (address) => {
      expect(insertLink('Keep my draft', { start: 0, end: 4 }, 'A link', address)).toBeNull();
    },
  );

  test('escapes a literal label and a parenthesized address without changing surrounding words', () => {
    const result = insertLink(
      'Before old after',
      { start: 7, end: 10 },
      'Plan [v2] *ready*',
      'https://example.com/a(b)',
    );
    if (result === null) throw new Error('valid address refused');
    const tree = parseMarkdown(result.text);
    const paragraph = tree?.children[0];
    if (paragraph?.type !== 'paragraph') throw new Error('not a paragraph');
    expect(paragraph.children.map((node) => node.type)).toEqual(['text', 'link', 'text']);
    const link = paragraph.children[1];
    if (link?.type !== 'link') throw new Error('missing link');
    expect(link.children).toEqual([{ type: 'text', value: 'Plan [v2] *ready*' }]);
    expect(link.url.href).toBe('https://example.com/a%28b%29');
    expect(result.text.startsWith('Before ')).toBe(true);
    expect(result.text.endsWith(' after')).toBe(true);
    expect(result.selection.start).toBe(result.text.length - ' after'.length);
  });

  test('an empty label uses the normalized address, and mail links use the same policy', () => {
    expect(insertLink('', { start: 0, end: 0 }, '', '  https://example.com  ')?.text).toBe(
      '[https://example.com/](https://example.com/)',
    );
    expect(insertLink('', { start: 0, end: 0 }, 'Team', 'mailto:team@example.com')?.text).toBe(
      '[Team](mailto:team@example.com)',
    );
  });
  test.each(['mailto:a b@example.com', 'mailto:test\\'])(
    'keeps the opaque address %s inside a single valid Markdown link',
    (address) => {
      const result = insertLink('', { start: 0, end: 0 }, 'Hello', address);
      if (result === null) throw new Error('valid address refused');
      const block = parseMarkdown(result.text)?.children[0];
      if (block?.type !== 'paragraph') throw new Error('not a paragraph');
      expect(block.children).toHaveLength(1);
      const link = block.children[0];
      if (link?.type !== 'link') throw new Error('not a link');
      expect(link.url.href).toBe(address.replace(/ /g, '%20').replace(/\\/g, '%5C'));
    },
  );
});
