import { describe, expect, test } from 'bun:test';
import {
  HTTP_DURATION_BUCKETS,
  createMetricsRegistry,
  modulesInfoFamily,
  renderMetrics,
  serverMetrics,
} from './metrics';
import { bundledModules, type BundledModule } from '../composition';
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
  test('say the process and every counter from the start, each counter at zero, one series for each owner the build has', () => {
    const modules = bundledModules.map((module) => module.manifest.id);
    const page = readExposition(renderMetrics(serverMetrics(fixedProcess, modules)));
    expect(sampleOf(page, 'purlay_process_uptime_seconds')).toBe(12.5);
    expect(sampleOf(page, 'purlay_process_resident_memory_bytes')).toBe(64 * 1024 * 1024);
    const owners = ['core', ...modules];
    for (const door of ['http', 'socket']) {
      for (const module of [...owners, 'none']) {
        expect(sampleOf(page, 'purlay_rate_limited_total', { door, module })).toBe(0);
      }
    }
    for (const reason of ['refused', 'not_taken', 'error', 'dropped', 'throttled']) {
      for (const module of owners) {
        expect(sampleOf(page, 'purlay_push_failures_total', { reason, module })).toBe(0);
      }
    }
    for (const module of owners) {
      expect(sampleOf(page, 'purlay_mail_failures_total', { module })).toBe(0);
    }
    expect(page.types.get('purlay_http_request_duration_seconds')).toBe('histogram');
  });

  test('count a module’s workers by the module and the worker, each at zero from the start and no other series', () => {
    const carried: readonly BundledModule[] = bundledModules;
    const workers = carried.flatMap((module) =>
      (module.workers ?? []).map(({ name }) => ({ module: module.manifest.id, name })),
    );
    expect(workers.length).toBeGreaterThan(0);
    const metrics = serverMetrics(fixedProcess, [], workers);
    const page = readExposition(renderMetrics(metrics));
    expect(page.types.get('purlay_worker_failures_total')).toBe('counter');
    for (const { module, name } of workers) {
      expect(sampleOf(page, 'purlay_worker_failures_total', { module, worker: name })).toBe(0);
    }
    const series = page.samples.filter((sample) => sample.name === 'purlay_worker_failures_total');
    expect(series).toHaveLength(workers.length);
    const [first] = workers;
    if (first === undefined) throw new Error('no worker');
    metrics.workerFailures.inc({ module: first.module, worker: first.name });
    expect(
      sampleOf(readExposition(renderMetrics(metrics)), 'purlay_worker_failures_total', {
        module: first.module,
        worker: first.name,
      }),
    ).toBe(1);
  });

  test('count the facts between modules by the module and fact type, each at zero from the start and no other series', () => {
    const facts = [
      { module: 'wiki', fact: 'notes.created' },
      { module: 'wiki', fact: 'notes.pinned' },
      { module: 'shelf', fact: 'notes.created' },
    ];
    const metrics = serverMetrics(fixedProcess, [], [], [], facts);
    const page = readExposition(renderMetrics(metrics));
    for (const name of [
      'purlay_outbox_delivered_total',
      'purlay_outbox_failures_total',
      'purlay_outbox_dropped_total',
      'purlay_outbox_refused_total',
    ]) {
      expect(page.types.get(name)).toBe('counter');
      expect(page.samples.filter((sample) => sample.name === name)).toHaveLength(facts.length);
      for (const labels of facts) expect(sampleOf(page, name, labels)).toBe(0);
    }
    metrics.outboxDropped.inc({ module: 'wiki', fact: 'notes.pinned' });
    metrics.outboxRefused.inc({ module: 'wiki', fact: 'notes.pinned' });
    expect(
      sampleOf(readExposition(renderMetrics(metrics)), 'purlay_outbox_dropped_total', {
        module: 'wiki',
        fact: 'notes.pinned',
      }),
    ).toBe(1);
    expect(
      sampleOf(readExposition(renderMetrics(metrics)), 'purlay_outbox_delivered_total', {
        module: 'wiki',
        fact: 'notes.pinned',
      }),
    ).toBe(0);
  });

  test('count the notices of the inbox by the module and kind a manifest declares, each at zero from the start and no other series', () => {
    const carried: readonly BundledModule[] = bundledModules;
    const notices = carried.flatMap((module) =>
      (module.manifest.notifications ?? []).map(({ type }) => ({
        module: module.manifest.id,
        kind: type,
      })),
    );
    expect(notices.length).toBeGreaterThan(0);
    const metrics = serverMetrics(fixedProcess, [], [], notices);
    const page = readExposition(renderMetrics(metrics));
    expect(page.types.get('purlay_inbox_entries_total')).toBe('counter');
    for (const { module, kind } of notices) {
      expect(sampleOf(page, 'purlay_inbox_entries_total', { module, kind })).toBe(0);
    }
    const series = page.samples.filter((sample) => sample.name === 'purlay_inbox_entries_total');
    expect(series).toHaveLength(notices.length);
    const [first] = notices;
    if (first === undefined) throw new Error('no notice');
    metrics.inboxEntries.inc(first);
    expect(
      sampleOf(readExposition(renderMetrics(metrics)), 'purlay_inbox_entries_total', first),
    ).toBe(1);
  });

  test('count no series for an owner it was not told of until a failure names it, and never one that is not an owner by name', () => {
    const page = readExposition(renderMetrics(serverMetrics(fixedProcess)));
    const modules = page.samples
      .filter((sample) => sample.name.startsWith('purlay_') && sample.name.endsWith('_total'))
      .flatMap((sample) => sample.labels['module'] ?? []);
    expect(new Set(modules)).toEqual(new Set(['core', 'none']));
  });

  test('say which memory figure the resident gauge is, since ps reads higher on macOS (#1028)', () => {
    const text = renderMetrics(serverMetrics(fixedProcess));
    const help = text
      .split('\n')
      .find((line) => line.startsWith('# HELP purlay_process_resident_memory_bytes'));
    expect(help).toContain('resident set on Linux');
    expect(help).toContain('physical footprint on macOS');
    expect(help).toContain('below ps');
  });

  test('the real process is read when no readings are handed in', () => {
    const page = readExposition(renderMetrics(serverMetrics()));
    expect(sampleOf(page, 'purlay_process_uptime_seconds')).toBeGreaterThan(0);
    expect(sampleOf(page, 'purlay_process_resident_memory_bytes')).toBeGreaterThan(1024 * 1024);
  });
});

describe('the modules on the page', () => {
  test('are one series of 1 per module, named by the module label', () => {
    const carried = bundledModules.map((module) => module.manifest.id);
    expect(carried.length).toBeGreaterThan(0);
    expect(modulesInfoFamily(carried)).toEqual({
      name: 'purlay_modules_info',
      help: 'The modules this process runs, one series of value 1 each.',
      type: 'gauge',
      samples: carried.map((id) => ({ suffix: '', labels: { module: id }, value: 1 })),
    });
    expect(modulesInfoFamily([]).samples).toEqual([]);
  });
});
