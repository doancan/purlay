/**
 * The channel switch, measured where it happens and kept there (O-5): a mark when the address
 * changes, a measure when the new feed's rows are drawn — so a week of real use can say whether the
 * 100 ms budget holds, with nothing sent anywhere (D-44).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRouter, type HistoryPort } from '../router/router';
import { ROUTE_MARK, SWITCH_MEASURE, measureSwitch } from './switch-timing';

afterEach(() => {
  performance.clearMarks(ROUTE_MARK);
  performance.clearMeasures(SWITCH_MEASURE);
});

const memoryHistory = (): HistoryPort => {
  let at = { pathname: '/w/acme/c/one', search: '' };
  return {
    read: () => at,
    push: (url): void => {
      at = { pathname: url, search: '' };
    },
    replace: (url): void => {
      at = { pathname: url, search: '' };
    },
    listen: () => () => undefined,
  };
};

describe('the channel switch, measured in the page', () => {
  test('a navigation leaves a mark; the same address again leaves none', () => {
    const router = createRouter(memoryHistory());
    router.navigate('/w/acme/c/two');
    expect(performance.getEntriesByName(ROUTE_MARK, 'mark')).toHaveLength(1);
    router.navigate('/w/acme/c/two');
    expect(performance.getEntriesByName(ROUTE_MARK, 'mark')).toHaveLength(1);
  });

  test('drawn after a navigation, a switch is one measure naming the channel; drawn again, it is not measured twice', () => {
    createRouter(memoryHistory()).navigate('/w/acme/c/two');
    measureSwitch('two');
    measureSwitch('two');
    const measures = performance.getEntriesByName(SWITCH_MEASURE, 'measure');
    expect(measures).toHaveLength(1);
    expect(measures[0]?.duration).toBeGreaterThanOrEqual(0);
    expect((measures[0] as PerformanceMeasure | undefined)?.detail).toEqual({ channelId: 'two' });
  });

  test('a feed drawn with no navigation before it — the first load — is not a switch', () => {
    measureSwitch('one');
    expect(performance.getEntriesByName(SWITCH_MEASURE, 'measure')).toHaveLength(0);
  });

  test('no more than five hundred are kept: a long day, not a growing heap', () => {
    for (let n = 0; n < 500; n += 1) performance.measure(SWITCH_MEASURE, { start: 0, end: 1 });
    createRouter(memoryHistory()).navigate('/w/acme/c/two');
    measureSwitch('two');
    const measures = performance.getEntriesByName(SWITCH_MEASURE, 'measure');
    expect(measures).toHaveLength(1);
    expect((measures[0] as PerformanceMeasure | undefined)?.detail).toEqual({ channelId: 'two' });
  });
});
