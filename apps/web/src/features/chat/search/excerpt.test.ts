/**
 * Where a result's words were found (#664): the excerpt shows them, marked, as the server matched them.
 */
import { describe, expect, test } from 'bun:test';
import { markedExcerpt, marksIn } from './excerpt';

describe('markedExcerpt', () => {
  test('the words as typed, ignoring case, are the match; the text around them is kept as it is', () => {
    expect(markedExcerpt('Deployed api to staging', 'deploy')).toEqual({
      before: '',
      match: 'Deploy',
      after: 'ed api to staging',
    });
  });

  test('a match far into a long message starts the excerpt a little before it, at a word, with an ellipsis', () => {
    const text = `${'word '.repeat(60)}the rollback needle is here, and more after it`;
    const marked = markedExcerpt(text, 'NEEDLE');
    expect(marked?.match).toBe('needle');
    expect(marked?.before.startsWith('…')).toBe(true);
    expect(marked?.before.endsWith('the rollback ')).toBe(true);
    // A little before: enough to read it in its place, not the whole message.
    expect((marked?.before.length ?? 0) <= 50).toBe(true);
    expect(marked?.before.slice(1, 2)).not.toBe(' ');
  });

  test('a match near the start keeps the start: no ellipsis', () => {
    expect(markedExcerpt('a short note about deploys', 'deploys')?.before).toBe(
      'a short note about ',
    );
  });

  test('the excerpt starts at the first match; the later ones are marked in what follows', () => {
    const marked = markedExcerpt('api then API again', 'api');
    expect(marked).toEqual({ before: '', match: 'api', after: ' then API again' });
    expect(marksIn(marked?.after ?? '', 'api')).toEqual([
      { text: ' then ', marked: false },
      { text: 'API', marked: true },
      { text: ' again', marked: false },
    ]);
  });

  test('words the excerpt does not hold — matched in the markdown, not the words — mark nothing', () => {
    expect(markedExcerpt('Deployed api', '`api`')).toBeNull();
  });

  test('surrounding spaces of the words are not part of what is looked for', () => {
    expect(markedExcerpt('the deploy is at noon', '  deploy ')?.match).toBe('deploy');
  });

  test('a letter whose lower case is longer, before the match, does not move it (İ)', () => {
    expect(markedExcerpt('İstanbul deploy notes', 'deploy')).toEqual({
      before: 'İstanbul ',
      match: 'deploy',
      after: ' notes',
    });
  });

  test('what the person typed is looked for as typed, pattern characters and all', () => {
    expect(markedExcerpt('the fix (part 2) is 100% done', '(part 2)')?.match).toBe('(part 2)');
    expect(markedExcerpt('the fix is 100% done', '100%')?.match).toBe('100%');
    expect(markedExcerpt('a.b and axb', 'a.b')?.before).toBe('');
    expect(markedExcerpt('axb only', 'a.b')).toBeNull();
  });

  // As the server matches since #701: case by Unicode, and I ı İ i one letter (#704).
  test('a match the server found across I, ı, İ and i is marked too', () => {
    expect(markedExcerpt('ÇAĞRI merkezi', 'çağrı')?.match).toBe('ÇAĞRI');
    expect(markedExcerpt('İstanbul toplantısı', 'istanbul')?.match).toBe('İstanbul');
    expect(markedExcerpt('Iğdır şubesi', 'ığdır')?.match).toBe('Iğdır');
    expect(markedExcerpt('ılık su', 'ILIK')?.match).toBe('ılık');
    // A word with none of them is matched as before, and a pattern character is still itself.
    expect(markedExcerpt('a [link] here', '[link]')?.match).toBe('[link]');
  });
});

describe('marksIn', () => {
  test('marks every match, back to back and at either end, folding I ı İ i as the server does', () => {
    expect(marksIn('İşte iş, IŞ', 'iş')).toEqual([
      { text: 'İş', marked: true },
      { text: 'te ', marked: false },
      { text: 'iş', marked: true },
      { text: ', ', marked: false },
      { text: 'IŞ', marked: true },
    ]);
    expect(marksIn('aaaa', 'aa')).toEqual([
      { text: 'aa', marked: true },
      { text: 'aa', marked: true },
    ]);
  });

  test('with nothing to find, or nothing typed, the text is one unmarked piece; empty text is none', () => {
    expect(marksIn('no match here', 'xyz')).toEqual([{ text: 'no match here', marked: false }]);
    expect(marksIn('words', '  ')).toEqual([{ text: 'words', marked: false }]);
    expect(marksIn('', 'api')).toEqual([]);
  });
});
