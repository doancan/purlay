import { describe, expect, test } from 'bun:test';
import {
  HTTP_DURATION_BUCKETS,
  createMetricsRegistry,
  renderMetrics,
  serverMetrics,
} from './metrics';
import { readExposition, sampleOf } from '../testing/exposition';

const fixedProcess = {
  uptimeSeconds: (): number => 12.5,
  residentBytes: (): number => 64 * 1024 * 1024,
};

describe('a counter', () => {
  test('rises by one, or by what it is given, per series its labels name', () => {
    const registry = createMetricsRegistry();
    const refused = registry.counter('purlay_refused_total', 'Refused.', ['door']);
    refused.inc({ door: 'http' });
    refused.inc({ door: 'http' }, 2);
    refused.inc({ door: 'socket' });
    const page = readExposition(renderMetrics({ ...serverMetrics(fixedProcess), registry }));
    expect(sampleOf(page, 'purlay_refused_total', { door: 'http' })).toBe(3);
    expect(sampleOf(page, 'purlay_refused_total', { door: 'socket' })).toBe(1);
  });

  test('never goes down, and never by an amount that is not a number', () => {
    const counter = createMetricsRegistry().counter('purlay_x_total', 'X.', []);
    expect(() => {
      counter.inc({}, -1);
    }).toThrow('never down');
    expect(() => {
      counter.inc({}, Number.NaN);
    }).toThrow('finite');
    expect(() => {
      counter.inc({}, Number.POSITIVE_INFINITY);
    }).toThrow('finite');
  });

  test('takes exactly the labels it declared: one missing, or one more, is a defect said at once', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter<'door'>('purlay_x_total', 'X.', ['door']);
    expect(() => {
      counter.inc({} as { door: string });
    }).toThrow('exactly door');
    expect(() => {
      counter.inc({ door: 'http', path: '/api/x' } as { door: string });
    }).toThrow('exactly door');
    expect(() => {
      const unlabelled = registry.counter('purlay_y_total', 'Y.', []);
      // Past the type, as a caller holding a wider record would: refused at run time too.
      const extra: Record<string, string> = { door: 'x' };
      unlabelled.inc(extra);
    }).toThrow('exactly none');
  });
});

describe('a histogram', () => {
  test('counts each observation in its bucket, cumulatively, with +Inf, a sum and a count', () => {
    const registry = createMetricsRegistry();
    const histogram = registry.histogram('purlay_t_seconds', 'T.', ['route'], [0.1, 1]);
    for (const value of [0.05, 0.1, 0.5, 3]) histogram.observe({ route: '/a' }, value);
    const page = readExposition(renderMetrics({ ...serverMetrics(fixedProcess), registry }));
    expect(sampleOf(page, 'purlay_t_seconds_bucket', { route: '/a', le: '0.1' })).toBe(2);
    expect(sampleOf(page, 'purlay_t_seconds_bucket', { route: '/a', le: '1' })).toBe(3);
    expect(sampleOf(page, 'purlay_t_seconds_bucket', { route: '/a', le: '+Inf' })).toBe(4);
    expect(sampleOf(page, 'purlay_t_seconds_count', { route: '/a' })).toBe(4);
    expect(sampleOf(page, 'purlay_t_seconds_sum', { route: '/a' })).toBeCloseTo(3.65, 10);
  });

  test('refuses an observation that is not a number, and buckets that do not rise', () => {
    const registry = createMetricsRegistry();
    expect(() => {
      registry.histogram('purlay_a', 'A.', [], [1]).observe({}, Number.NaN);
    }).toThrow('finite');
    expect(() => registry.histogram('purlay_b', 'B.', [], [])).toThrow('rising');
    expect(() => registry.histogram('purlay_c', 'C.', [], [1, 1])).toThrow('rising');
    expect(() => registry.histogram('purlay_d', 'D.', [], [2, 1])).toThrow('rising');
    expect(() => registry.histogram('purlay_e', 'E.', [], [1, Infinity])).toThrow('rising');
    // Below zero is a bucket like any other, so long as they rise.
    expect(() => registry.histogram('purlay_f', 'F.', [], [-1, 0, 1])).not.toThrow();
  });

  test('the request buckets rise, from a few milliseconds to ten seconds', () => {
    expect(HTTP_DURATION_BUCKETS[0]).toBe(0.005);
    expect(HTTP_DURATION_BUCKETS.at(-1)).toBe(10);
    expect([...HTTP_DURATION_BUCKETS].sort((a, b) => a - b)).toEqual([...HTTP_DURATION_BUCKETS]);
  });
});

describe('the registry', () => {
  test('reads a gauge when the page is asked for, not when it was declared', () => {
    const registry = createMetricsRegistry();
    let open = 1;
    registry.gauge('purlay_open', 'Open.', () => open);
    open = 7;
    expect(registry.families()[0]?.samples[0]?.value).toBe(7);
  });

  test('refuses a name declared twice, a name Prometheus cannot read, and a label it keeps for itself', () => {
    const registry = createMetricsRegistry();
    registry.counter('purlay_x_total', 'X.', []);
    expect(() => {
      registry.gauge('purlay_x_total', 'Again.', () => 0);
    }).toThrow('declared twice');
    expect(() => registry.counter('purlay-x', 'X.', [])).toThrow('not a metric name');
    expect(() => registry.counter('purlay_y_total', 'Y.', ['__name__'])).toThrow(
      'not a label name',
    );
    expect(() => registry.histogram('purlay_z', 'Z.', ['le'], [1])).toThrow('not a label name');
  });
});

describe("the server's instruments", () => {
  test('say the process and every counter from the start, each counter at zero', () => {
    const page = readExposition(renderMetrics(serverMetrics(fixedProcess)));
    expect(sampleOf(page, 'purlay_process_uptime_seconds')).toBe(12.5);
    expect(sampleOf(page, 'purlay_process_resident_memory_bytes')).toBe(64 * 1024 * 1024);
    for (const door of ['http', 'socket']) {
      expect(sampleOf(page, 'purlay_rate_limited_total', { door })).toBe(0);
    }
    for (const reason of ['refused', 'not_taken', 'error', 'dropped']) {
      expect(sampleOf(page, 'purlay_push_failures_total', { reason })).toBe(0);
    }
    expect(sampleOf(page, 'purlay_mail_failures_total')).toBe(0);
    expect(page.types.get('purlay_http_request_duration_seconds')).toBe('histogram');
  });

  test('the real process is read when no readings are handed in', () => {
    const page = readExposition(renderMetrics(serverMetrics()));
    expect(sampleOf(page, 'purlay_process_uptime_seconds')).toBeGreaterThan(0);
    expect(sampleOf(page, 'purlay_process_resident_memory_bytes')).toBeGreaterThan(1024 * 1024);
  });
});
