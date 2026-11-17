import { describe, expect, test } from 'bun:test';
import { formattingRanges } from '@purlay/markdown';
import { activeFormatting } from './active-formatting';

describe('formatting at the writing position', () => {
  test.each([
    ['**bo¦ld**', ['bold']],
    ['__bo¦ld__', ['bold']],
    ['_ita¦lic_', ['italic']],
    ['***bo¦th***', ['bold', 'italic']],
    ['~~stri¦ke~~', ['strike']],
    ['~stri¦ke~', ['strike']],
    ['`co¦de`', ['inlineCode']],
    ['``one ` ba¦cktick``', ['inlineCode']],
    ['`**literal¦**`', ['inlineCode']],
    ['\\*\\*literal¦\\*\\*', []],
    ['before¦ **bold**', []],
    ['**bold**¦ plain', []],
    ['**unfinished¦', []],
    ['> **quo¦ted**', ['bold', 'quote']],
    ['- it¦em', ['bullets']],
    ['1. it¦em', ['numbers']],
    ['- [ ] it¦em', ['tasks']],
    ['- [x] it¦em', ['tasks']],
    ['- parent\n  1. chi¦ld', ['numbers']],
    ['- plain\n- [ ] ta¦sk', ['tasks']],
    ['- ¦', ['bullets']],
    ['- [ ] ¦', ['tasks']],
    ['```ts\n**literal¦**\n```', ['code']],
    ['```ts\nunfinished¦', ['code']],
    ['**¦**', ['bold']],
    ['_¦_', ['italic']],
    ['~~¦~~', ['strike']],
    ['`¦`', ['inlineCode']],
    ['<https://example.com/**¦**>', []],
    ['<https://example.com/**bo¦ld**>', []],
    ['**wo**¦**rd**', []],
    ['`wo`¦`rd`', []],
    ['_wo_¦_rd_', ['italic']],
  ] as const)('%s', (marked, expected) => {
    const at = marked.indexOf('¦');
    const text = marked.replace('¦', '');
    expect(
      [...activeFormatting(text, formattingRanges(text), { start: at, end: at })].sort(),
    ).toEqual([...expected].sort());
  });

  test.each([
    ['«**bold**»', ['bold']],
    ['**«bold»**', ['bold']],
    ['**bold «and** plain»', []],
    ['**«bold _and_ more»**', ['bold']],
    ['- «one\n- two»', ['bullets']],
    ['- [ ] «one\n- [x] two»', ['tasks']],
    ['«**bold** _italic_»', []],
    ['- [ ] «parent\n  1. child»', []],
    ['- «parent\n  1. child»', []],
    ['- «parent\n  - child»', ['bullets']],
  ] as const)('the whole selection in %s', (marked, expected) => {
    const start = marked.indexOf('«');
    const end = marked.indexOf('»') - 1;
    const text = marked.replace('«', '').replace('»', '');
    expect([...activeFormatting(text, formattingRanges(text), { start, end })].sort()).toEqual(
      [...expected].sort(),
    );
  });

  test('a source the renderer refuses has no active formatting, including pending markers', () => {
    expect([...activeFormatting('****', null, { start: 2, end: 2 })]).toEqual([]);
  });
});
