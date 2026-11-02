import { describe, expect, test } from 'bun:test';
import { exposition, formatValue, isLabelName, isMetricName } from './exposition';
import { readExposition } from '../testing/exposition';

describe('the text exposition format', () => {
  test('writes a family as its HELP, its TYPE and its samples, and ends the page with a line break', () => {
    const page = exposition([
      {
        name: 'purlay_things_total',
        help: 'Things.',
        type: 'counter',
        samples: [
          { suffix: '', labels: { kind: 'a' }, value: 1 },
          { suffix: '', labels: { kind: 'b' }, value: 2 },
        ],
      },
      {
        name: 'purlay_open',
        help: 'Open.',
        type: 'gauge',
        samples: [{ suffix: '', labels: {}, value: 0 }],
      },
    ]);
    expect(page).toBe(
      [
        '# HELP purlay_things_total Things.',
        '# TYPE purlay_things_total counter',
        'purlay_things_total{kind="a"} 1',
        'purlay_things_total{kind="b"} 2',
        '# HELP purlay_open Open.',
        '# TYPE purlay_open gauge',
        'purlay_open 0',
        '',
      ].join('\n'),
    );
    expect(readExposition(page).samples).toHaveLength(3);
  });

  test('nothing to say is an empty page, which a scraper reads as no samples', () => {
    expect(exposition([])).toBe('');
    expect(readExposition('').samples).toEqual([]);
  });

  test('a family with no samples yet still says what it is', () => {
    const page = exposition([{ name: 'purlay_x', help: 'X.', type: 'histogram', samples: [] }]);
    expect(page).toBe('# HELP purlay_x X.\n# TYPE purlay_x histogram\n');
  });

  /**
   * A label value is the one place text reaches the page; a quote, a backslash or a line break left
   * as it is ends the sample early, and the scrape fails from there on.
   */
  test('escapes a backslash, a double quote and a line break in a label value, and reads back as written', () => {
    const awkward = 'a\\b"c\nd — çğış 🙂 <script>';
    const page = exposition([
      {
        name: 'purlay_x',
        help: 'X.',
        type: 'gauge',
        samples: [{ suffix: '', labels: { v: awkward }, value: 1 }],
      },
    ]);
    expect(page).toContain('purlay_x{v="a\\\\b\\"c\\nd — çğış 🙂 <script>"} 1');
    expect(readExposition(page).samples[0]?.labels['v']).toBe(awkward);
  });

  test('escapes a backslash and a line break in HELP, which may carry a quote as it is', () => {
    const page = exposition([
      { name: 'purlay_x', help: 'one\\two\n"three"', type: 'gauge', samples: [] },
    ]);
    expect(page.split('\n')[0]).toBe('# HELP purlay_x one\\\\two\\n"three"');
  });

  test('spells the numbers that are not finite as Go reads them', () => {
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(0.005)).toBe('0.005');
    expect(formatValue(1e21)).toBe('1e+21');
    expect(formatValue(-3)).toBe('-3');
  });

  test('a metric name and a label name are what Prometheus accepts, and nothing else', () => {
    for (const good of ['a', 'purlay_x_total', 'ns:sub_x', '_x'])
      expect(isMetricName(good)).toBe(true);
    for (const bad of ['', '1x', 'a-b', 'a b', 'ç']) expect(isMetricName(bad)).toBe(false);
    for (const good of ['a', 'route', '_x']) expect(isLabelName(good)).toBe(true);
    for (const bad of ['', '__name__', '1a', 'a:b', 'a-b']) expect(isLabelName(bad)).toBe(false);
  });
});

describe('the strict reader the tests check pages with', () => {
  /** A reader that accepts everything would make every page test above pass for nothing. */
  test('refuses what the format does not allow', () => {
    expect(() => readExposition('purlay_x 1')).toThrow('line break');
    expect(() => readExposition('purlay_x 1\n')).toThrow('before its TYPE');
    expect(() => readExposition('# TYPE purlay_x gauge\n# TYPE purlay_x gauge\n')).toThrow('twice');
    expect(() => readExposition('# TYPE purlay_x thing\n')).toThrow('not a metric type');
    expect(() => readExposition('# TYPE purlay_x gauge\npurlay_x{v="a"b"} 1\n')).toThrow(
      'sample line',
    );
    expect(() => readExposition('# TYPE purlay_x gauge\npurlay_x one\n')).toThrow('sample value');
    expect(() => readExposition('# TYPE purlay_x gauge\npurlay_y_count 1\n')).toThrow(
      'before its TYPE',
    );
  });

  test('reads the values that are not finite', () => {
    const page = readExposition('# TYPE x gauge\nx +Inf\nx -Inf\nx NaN\n');
    expect(page.samples.map((sample) => sample.value)).toEqual([Infinity, -Infinity, Number.NaN]);
  });
});
