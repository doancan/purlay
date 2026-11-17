import { describe, expect, test } from 'bun:test';
import { formattingRanges } from './formatting';

describe('formatting source ranges', () => {
  test('positions use textarea UTF-16 offsets, including emoji before the format', () => {
    const source = '🚀 **İstanbul**';
    const ranges = formattingRanges(source);
    const bold = ranges?.find((range) => range.kind === 'bold');
    if (bold === undefined) throw new Error('no strong range');
    expect(source.slice(bold.start, bold.end)).toBe('**İstanbul**');
    expect(source.slice(bold.contentStart, bold.contentEnd)).toBe('İstanbul');
    expect(bold.start).toBe(3);
  });

  test('the rendering bounds also bound source metadata', () => {
    expect(formattingRanges('> '.repeat(500) + '**word**')).toBeNull();
  });

  test('code contents never create emphasis or list ranges', () => {
    expect(formattingRanges('```\n**bold**\n- item\n```')?.map((range) => range.kind)).toEqual([
      'code',
    ]);
  });
});
