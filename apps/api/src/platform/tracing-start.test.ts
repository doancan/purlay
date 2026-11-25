/**
 * Tracing at the process's start (#1307, D-336): off where no collector is named, on where one is, the settings refused when they
 * are not an address or not pairs, and the credential of the collector in no message and no span.
 */
import { describe, expect, test } from 'bun:test';
import { aMovableClock, NOW } from '../testing/doubles';
import { ConfigurationError, DEVELOPMENT_ENCRYPTION_KEY, loadConfig, otlpHeaders } from './config';
import { createMetricsRegistry } from './metrics';
import { startTracing } from './tracing-start';
import { noTracer, tracer, useTracer } from './tracing';

const valid = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://purlay:purlay@localhost:5432/purlay',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
};

const problemsOf = (env: Record<string, string>): readonly string[] => {
  try {
    loadConfig({ ...valid, ...env });
    return [];
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems;
    throw error;
  }
};

describe('the settings of tracing', () => {
  test('are off by default, and a ratio of a tenth', () => {
    const config = loadConfig(valid);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(config.TRACE_SAMPLE_RATIO).toBe(0.1);
  });

  test('take an http or https address of a collector, and headers as name=value pairs', () => {
    expect(
      problemsOf({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc, authorization=Bearer t',
        TRACE_SAMPLE_RATIO: '0.5',
      }),
    ).toEqual([]);
    expect(
      otlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc, Authorization=Bearer t' }),
    ).toEqual({
      'x-api-key': 'abc',
      authorization: 'Bearer t',
    });
  });

  test.each([
    ['an address that is not one', { OTEL_EXPORTER_OTLP_ENDPOINT: 'collector' }, 'not an address'],
    [
      'a scheme that is not http',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector.test' },
      'an http or https address',
    ],
    [
      'a credential in the address',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pass@collector.test' },
      'no credentials in the address',
    ],
    [
      'headers with no endpoint',
      { OTEL_EXPORTER_OTLP_HEADERS: 'a=b' },
      'needs OTEL_EXPORTER_OTLP_ENDPOINT',
    ],
    [
      'headers that are not pairs',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.test', OTEL_EXPORTER_OTLP_HEADERS: 'nope' },
      'name=value pairs',
    ],
    [
      'a header with an empty value',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.test', OTEL_EXPORTER_OTLP_HEADERS: 'a=' },
      'name=value pairs',
    ],
    [
      'a header name that is not one',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.test', OTEL_EXPORTER_OTLP_HEADERS: 'bad name=1' },
      'name=value pairs',
    ],
  ])('refuse %s, saying why and never quoting the value', (_name, env, sentence) => {
    const problems = problemsOf(env);
    expect(problems.some((problem) => problem.includes(sentence))).toBe(true);
    for (const value of Object.values(env)) {
      for (const problem of problems) {
        if (value.length > 6) expect(problem).not.toContain(value);
      }
    }
  });

  test.each(['-0.1', '1.1', 'many'])('refuse a ratio of %s', (ratio) => {
    expect(problemsOf({ TRACE_SAMPLE_RATIO: ratio }).length).toBeGreaterThan(0);
  });
});

describe('starting tracing', () => {
  const counters = (): ReturnType<typeof createMetricsRegistry> => createMetricsRegistry();

  test('is nothing where no collector is named: no tracer is set, and the process’s stays off', () => {
    const registry = counters();
    const traceSpans = registry.counter('t_spans', 'spans', ['outcome']);
    expect(
      startTracing(
        { TRACE_SAMPLE_RATIO: 1 },
        { clock: aMovableClock(NOW), metrics: { traceSpans } },
      ),
    ).toBeUndefined();
    expect(tracer()).toBe(noTracer);
  });

  test('sets the process’s tracer, sends to the collector with its headers, counts what was exported, and the stop sends what is held', async () => {
    const registry = counters();
    const traceSpans = registry.counter('t_spans2', 'spans', ['outcome']);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const before = tracer();
    const tracing = startTracing(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc',
        TRACE_SAMPLE_RATIO: 1,
      },
      {
        clock: aMovableClock(NOW),
        metrics: { traceSpans },
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          seen.push({
            url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
            headers: init?.headers as Record<string, string>,
          });
          return await Promise.resolve(new Response(null, { status: 200 }));
        }) as unknown as typeof fetch,
      },
    );
    try {
      expect(tracing).toBeDefined();
      expect(tracer().enabled).toBe(true);
      tracer().start('request').end();
      await tracing?.stop();
    } finally {
      useTracer(before);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://collector.test/v1/traces');
    expect(seen[0]?.headers['x-api-key']).toBe('abc');
    const family = registry.families().find((one) => one.name === 't_spans2');
    expect(family?.samples.map((sample) => [sample.labels['outcome'], sample.value])).toEqual([
      ['exported', 1],
    ]);
  });
});
