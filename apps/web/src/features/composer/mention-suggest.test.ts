import { describe, expect, test } from 'bun:test';
import type { User } from '@purlay/types';
import {
  SUGGESTIONS_MAX,
  fold,
  insertMention,
  mentionQuery,
  offerable,
  suggest,
} from './mention-suggest';

const person = (username: string, displayName: string, id = username): User => ({
  id,
  username,
  displayName,
  avatarUrl: null,
});

const ALICE = person('alice', 'Alice Chen');
const ALI = person('aliveli', 'Ali Veli');
const DOGANCAN = person('dogancan', 'Doğancan');
const ISIL = person('isil-k', 'Işıl Kaya');
const SUKRU = person('sukru', 'Şükrü Çelik');
const BOB = person('bob', 'Bob Okafor');

const at = (typed: string): ReturnType<typeof mentionQuery> => mentionQuery(typed, typed.length);

describe('mentionQuery', () => {
  test('is the letters after an @ up to the caret', () => {
    expect(at('hi @ali')).toEqual({ start: 3, query: 'ali' });
    expect(at('@a')).toEqual({ start: 0, query: 'a' });
    expect(at('line\n@do')).toEqual({ start: 5, query: 'do' });
  });

  test('is nothing for a lone @, after a space, or with the caret elsewhere', () => {
    expect(at('hi @')).toBeNull();
    expect(at('hi @ali ')).toBeNull();
    expect(mentionQuery('hi @ali there', 'hi'.length)).toBeNull();
    expect(at('no mention')).toBeNull();
    expect(at('')).toBeNull();
  });

  test('reads the caret, not the end of the text', () => {
    expect(mentionQuery('hi @al and more', 'hi @al'.length)).toEqual({ start: 3, query: 'al' });
  });

  test('is nothing where the @ is glued to a word, an address or another @', () => {
    expect(at('mail me at me@example')).toBeNull();
    expect(at('@@ali')).toBeNull();
    expect(at('`code`@ali')).toBeNull();
  });

  test('is nothing inside a code fence, and something again after it closes', () => {
    expect(at('```\n@ali')).toBeNull();
    expect(at('```\nx\n```\n@ali')).toEqual({ start: 10, query: 'ali' });
  });

  test('is nothing for a run longer than any handle', () => {
    expect(at(`@${'a'.repeat(65)}`)).toBeNull();
    expect(at(`@${'a'.repeat(64)}`)).not.toBeNull();
  });
});

describe('fold', () => {
  test('drops case and the Turkish marks, and makes ı an i', () => {
    expect(fold('ĞğIıİiŞşÇçÖöÜü')).toBe('ggiiiissccoouu');
    expect(fold('Doğancan')).toBe('dogancan');
  });
});

describe('suggest', () => {
  const people = [BOB, DOGANCAN, ISIL, SUKRU, ALI, ALICE];

  test('matches the display name and the handle, case-insensitively', () => {
    expect(suggest(people, 'ALI').map((p) => p.username)).toEqual(['aliveli', 'alice']);
    expect(suggest(people, 'okafor').map((p) => p.username)).toEqual(['bob']);
    expect(suggest(people, 'isil-').map((p) => p.username)).toEqual(['isil-k']);
  });

  test('matches across Turkish letters, either way round', () => {
    expect(suggest(people, 'dogan').map((p) => p.username)).toEqual(['dogancan']);
    expect(suggest(people, 'doğan').map((p) => p.username)).toEqual(['dogancan']);
    expect(suggest(people, 'ışıl').map((p) => p.username)).toEqual(['isil-k']);
    expect(suggest(people, 'şükr').map((p) => p.username)).toEqual(['sukru']);
    expect(suggest(people, 'celik').map((p) => p.username)).toEqual(['sukru']);
  });

  test('puts a start before a word before the middle', () => {
    const people2 = [
      person('xchen', 'Chen Ma'),
      person('mchen', 'Ma Chen'),
      person('lichen', 'Li Ochen'),
    ];
    // Starts: the handle or name of xchen? "chen" starts Chen Ma's name; Ma Chen has it as a word;
    // Li Ochen only contains it.
    expect(suggest(people2, 'chen').map((p) => p.username)).toEqual(['xchen', 'mchen', 'lichen']);
  });

  test('is nobody for letters nobody has, and at most a screenful', () => {
    expect(suggest(people, 'zzz')).toEqual([]);
    const many = Array.from({ length: 20 }, (_, n) => person(`a${String(n)}`, `A ${String(n)}`));
    expect(suggest(many, 'a')).toHaveLength(SUGGESTIONS_MAX);
  });

  test('is nobody once a handle is typed out and nobody else matches; a handle inside a longer one still lists both', () => {
    expect(suggest(people, 'alice')).toEqual([]);
    expect(suggest(people, 'ALICE')).toEqual([]);
    const ali = person('ali', 'Ali Can');
    expect(suggest([...people, ali], 'ali').map((p) => p.username)).toEqual([
      'ali',
      'aliveli',
      'alice',
    ]);
  });
});

describe('offerable', () => {
  test('is everybody but the writer, a broadcast handle and a repeat', () => {
    const here = person('here', 'Somebody Called Here');
    expect(
      offerable([DOGANCAN, ALICE, here, ALICE, BOB], 'dogancan').map((p) => p.username),
    ).toEqual(['alice', 'bob']);
  });
});

describe('insertMention', () => {
  test('writes the handle and one space, and leaves the rest as it was', () => {
    expect(insertMention('hi @ali', { start: 3, query: 'ali' }, 'alice')).toEqual({
      text: 'hi @alice ',
      caret: 10,
    });
    expect(insertMention('hi @al, see this', { start: 3, query: 'al' }, 'alice')).toEqual({
      text: 'hi @alice , see this',
      caret: 10,
    });
    expect(insertMention('@al there', { start: 0, query: 'al' }, 'alice')).toEqual({
      text: '@alice there',
      caret: 7,
    });
  });
});
