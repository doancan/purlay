/**
 * Traces (#1307, D-336): the context on the wire, who is recorded, what a span may say, and what becomes of ended spans when the
 * collector is slow, refuses or is gone. The collector is the test's own `fetch`; nothing leaves the process.
 */
import { describe, expect, test } from 'bun:test';
import { aMovableClock, NOW } from '../testing/doubles';
import {
  ATTRIBUTES,
  QUEUE_MAX,
  createOtlpSink,
  createTracer,
  formatTraceparent,
  noTracer,
  otlpBody,
  parseTraceparent,
  sampledAt,
  tracer,
  useTracer,
  type EndedSpan,
  type SpanOutcome,
  type SpanSink,
} from './tracing';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('the trace context on the wire', () => {
  test('is read and written as the specification has it', () => {
    const parsed = parseTraceparent(`00-${TRACE}-${SPAN}-01`);
    expect(parsed).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
    expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(
      `00-${TRACE}-${SPAN}-00`,
    );
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
  });

  test.each([
    ['nothing', null],
    ['an empty header', ''],
    ['words', 'hello'],
    ['an all-zero trace', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['an all-zero span', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['the version ff', `ff-${TRACE}-${SPAN}-01`],
    ['upper-case digits', `00-${TRACE.toUpperCase()}-${SPAN}-01`],
    ['a short trace', `00-${TRACE.slice(1)}-${SPAN}-01`],
    ['an extra field in version 00', `00-${TRACE}-${SPAN}-01-extra`],
    ['a trailing space of garbage', `00-${TRACE}-${SPAN}-01 x`],
  ])('is not taken from %s', (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe('which traces are recorded', () => {
  test('all at 1, none at 0, and the same answer for the same trace on every node', () => {
    expect(sampledAt(TRACE, 1)).toBe(true);
    expect(sampledAt(TRACE, 0)).toBe(false);
    expect(sampledAt(TRACE, 0.5)).toBe(sampledAt(TRACE, 0.5));
  });

  test('about the share asked for, over many traces', () => {
    let kept = 0;
    for (let n = 0; n < 4_000; n += 1) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (sampledAt(id, 0.25)) kept += 1;
    }
    expect(kept).toBeGreaterThan(800);
    expect(kept).toBeLessThan(1_200);
  });
});

const collecting = (): { sink: SpanSink; ended: EndedSpan[] } => {
  const ended: EndedSpan[] = [];
  return {
    ended,
    sink: {
      accept: (span): void => {
        ended.push(span);
      },
    },
  };
};

describe('a span', () => {
  test('is a child of the parent it is given, in its trace, and says so on the wire', () => {
    const { sink, ended } = collecting();
    const t = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 1 });
    const parent = { traceId: TRACE, spanId: SPAN, sampled: true };
    const span = t.start('fact.deliver', { parent, kind: 'consumer' });
    expect(span.context.traceId).toBe(TRACE);
    expect(span.context.spanId).not.toBe(SPAN);
    span.end();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ traceId: TRACE, parentSpanId: SPAN, kind: 'consumer' });
  });

  test('is the root of a new trace where nothing is inherited, and the ratio decides', () => {
    const { sink, ended } = collecting();
    const everything = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 1 });
    everything.start('request').end();
    expect(ended[0]?.parentSpanId).toBeUndefined();
    expect(ended[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    const nothing = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 0 });
    const unrecorded = nothing.start('request');
    expect(unrecorded.recording).toBe(false);
    unrecorded.end();
    expect(ended).toHaveLength(1);
  });

  test('keeps the decision of the trace it joins, whatever the ratio: a child of an unrecorded trace is not recorded', () => {
    const { sink, ended } = collecting();
    const all = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 1 });
    const child = all.start('x', { parent: { traceId: TRACE, spanId: SPAN, sampled: false } });
    expect(child.recording).toBe(false);
    expect(child.context.sampled).toBe(false);
    child.end();
    expect(ended).toEqual([]);
    const none = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 0 });
    const joined = none.start('x', { parent: { traceId: TRACE, spanId: SPAN, sampled: true } });
    expect(joined.recording).toBe(true);
    joined.end();
    expect(ended).toHaveLength(1);
  });

  test('ends once, and says what its attributes are only for the names on the list and of the kind each is', () => {
    const { sink, ended } = collecting();
    const t = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 1 });
    const span = t.start('request', { kind: 'server' });
    span.setAttribute('http.route', '/api/workspaces/:workspaceId/issues');
    span.setAttribute('http.response.status_code', 201);
    // The wrong kind of value for its name is not kept, and a name that is not on the list is not either.
    const loose = span.setAttribute as (name: string, value: unknown) => void;
    loose('http.response.status_code', '201');
    loose('not.on.the.list', 'x');
    span.setError();
    span.end();
    span.end();
    expect(ended).toHaveLength(1);
    expect([...(ended[0]?.attributes ?? [])]).toEqual([
      ['http.route', '/api/workspaces/:workspaceId/issues'],
      ['http.response.status_code', 201],
    ]);
    expect(ended[0]?.error).toBe(true);
    expect(ended[0] !== undefined && ended[0].endUnixNano >= ended[0].startUnixNano).toBe(true);
  });

  test('the attributes a span may carry are a short list of names our code sets, and none names a person, a path, a body or a workspace', () => {
    expect(Object.keys(ATTRIBUTES).sort()).toEqual([
      'http.request.method',
      'http.response.status_code',
      'http.route',
      'purlay.fact.consumer',
      'purlay.fact.outcome',
      'purlay.fact.type',
      'purlay.job',
      'purlay.module',
    ]);
    for (const name of Object.keys(ATTRIBUTES)) {
      expect(name.replace('purlay.', '')).not.toMatch(
        /user|person|workspace|body|payload|header|query|url|path|email/,
      );
    }
  });
});

describe('the process’s tracer', () => {
  test('is off until it is set, and a test puts back the one it found', () => {
    expect(tracer()).toBe(noTracer);
    const { sink } = collecting();
    const mine = createTracer({ sink, clock: aMovableClock(NOW), sampleRatio: 1 });
    const before = useTracer(mine);
    expect(before).toBe(noTracer);
    expect(tracer()).toBe(mine);
    useTracer(before);
    expect(tracer().enabled).toBe(false);
    expect(noTracer.start('x').recording).toBe(false);
  });
});

const aSpan = (n: number, error = false): EndedSpan => ({
  name: `span-${String(n)}`,
  kind: 'server',
  traceId: TRACE,
  spanId: n.toString(16).padStart(16, '0'),
  parentSpanId: n === 0 ? undefined : SPAN,
  startUnixNano: 1_700_000_000_000_000_000n + BigInt(n),
  endUnixNano: 1_700_000_000_000_000_500n + BigInt(n),
  attributes: new Map([['http.route', '/x']]),
  error,
});

describe('what is sent to the collector', () => {
  test('is OTLP’s JSON of traces: the service, the spans, 64-bit times as strings, a status of error only for an error', () => {
    const body = otlpBody([aSpan(0), aSpan(1, true)], { name: 'purlay-api', version: '1.2.3' }) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { spans: Record<string, unknown>[] }[];
      }[];
    };
    const [resource] = body.resourceSpans;
    expect(resource?.resource.attributes.map((a) => [a.key, a.value.stringValue])).toEqual([
      ['service.name', 'purlay-api'],
      ['service.version', '1.2.3'],
    ]);
    const spans = resource?.scopeSpans[0]?.spans ?? [];
    expect(spans[0]).toMatchObject({
      traceId: TRACE,
      name: 'span-0',
      kind: 2,
      startTimeUnixNano: '1700000000000000000',
      endTimeUnixNano: '1700000000000000500',
      status: { code: 1 },
      attributes: [{ key: 'http.route', value: { stringValue: '/x' } }],
    });
    expect(spans[0]).not.toHaveProperty('parentSpanId');
    expect(spans[1]).toMatchObject({ parentSpanId: SPAN, status: { code: 2 } });
  });
});

interface Posted {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly spans: number;
}

const aCollector = (
  behave: (n: number) => Promise<Response> | Response = () => new Response(null, { status: 200 }),
): { fetch: typeof fetch; posted: Posted[]; counts: Record<SpanOutcome, number> } => {
  const posted: Posted[] = [];
  const counts: Record<SpanOutcome, number> = { exported: 0, dropped: 0, failed: 0 };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(text) as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    posted.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: init?.headers as Record<string, string>,
      spans: body.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0,
    });
    return await behave(posted.length);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, posted, counts };
};

const sinkOver = (
  collector: ReturnType<typeof aCollector>,
  extra: { batchMax?: number; queueMax?: number; timeoutMs?: number } = {},
): ReturnType<typeof createOtlpSink> =>
  createOtlpSink({
    endpoint: 'https://collector.test:4318/',
    headers: { authorization: 'Bearer secret-token' },
    serviceName: 'purlay-api',
    serviceVersion: '0.0.0',
    fetch: collector.fetch,
    counted: (outcome, spans): void => {
      collector.counts[outcome] += spans;
    },
    intervalMs: 3_600_000,
    ...extra,
  });

describe('the exporter', () => {
  test('posts held spans to the collector’s traces path with its headers, and counts them exported', async () => {
    const collector = aCollector();
    const sink = sinkOver(collector);
    for (let n = 0; n < 3; n += 1) sink.accept(aSpan(n));
    await sink.flush();
    sink.stop();
    expect(collector.posted).toHaveLength(1);
    expect(collector.posted[0]).toMatchObject({
      url: 'https://collector.test:4318/v1/traces',
      spans: 3,
    });
    expect(collector.posted[0]?.headers['authorization']).toBe('Bearer secret-token');
    expect(collector.posted[0]?.headers['content-type']).toBe('application/json');
    expect(collector.counts).toEqual({ exported: 3, dropped: 0, failed: 0 });
  });

  test('sends a full batch at once, and the rest at the flush, never more than the batch in a post', async () => {
    const collector = aCollector();
    const sink = sinkOver(collector, { batchMax: 4 });
    for (let n = 0; n < 10; n += 1) sink.accept(aSpan(n));
    await sink.flush();
    sink.stop();
    expect(collector.posted.every((post) => post.spans <= 4)).toBe(true);
    expect(collector.counts.exported).toBe(10);
  });

  test('drops the oldest span and counts it when the queue is full, and the queue never holds more than it may', async () => {
    const collector = aCollector();
    const sink = sinkOver(collector, { queueMax: 5, batchMax: 1_000 });
    for (let n = 0; n < 8; n += 1) sink.accept(aSpan(n));
    expect(collector.counts.dropped).toBe(3);
    await sink.flush();
    sink.stop();
    expect(collector.counts.exported).toBe(5);
    expect(QUEUE_MAX).toBeGreaterThan(0);
  });

  test('a collector that refuses, throws or never answers costs the batch and a count, and nobody a request', async () => {
    const refusing = aCollector(() => new Response(null, { status: 503 }));
    const a = sinkOver(refusing);
    a.accept(aSpan(0));
    await a.flush();
    a.stop();
    expect(refusing.counts).toEqual({ exported: 0, dropped: 0, failed: 1 });

    const throwing = aCollector(() => Promise.reject(new Error('ECONNREFUSED')));
    const b = sinkOver(throwing);
    b.accept(aSpan(0));
    b.accept(aSpan(1));
    await b.flush();
    b.stop();
    expect(throwing.counts.failed).toBe(2);

    const silent = aCollector(async () => await new Promise<Response>(() => undefined));
    const c = sinkOver(silent, { timeoutMs: 30 });
    c.accept(aSpan(0));
    const started = performance.now();
    // The test's own fetch ignores the signal; the timeout is the real one's, and what the sink promises is that it is passed.
    const posting = c.flush();
    await Promise.race([posting, Bun.sleep(100)]);
    c.stop();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('passes a timeout and refuses redirects, so a collector cannot hold it or send it elsewhere', async () => {
    let seen: RequestInit | undefined;
    const collector = aCollector();
    const sink = createOtlpSink({
      endpoint: 'https://collector.test',
      headers: {},
      serviceName: 's',
      serviceVersion: 'v',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen = init;
        return await Promise.resolve(new Response(null, { status: 200 }));
      }) as unknown as typeof fetch,
      counted: (outcome, spans): void => {
        collector.counts[outcome] += spans;
      },
      intervalMs: 3_600_000,
    });
    sink.accept(aSpan(0));
    await sink.flush();
    sink.stop();
    expect(seen?.redirect).toBe('error');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  test('never puts the collector’s credential in what it sends', async () => {
    const collector = aCollector();
    const sink = sinkOver(collector);
    sink.accept(aSpan(0));
    await sink.flush();
    sink.stop();
    expect(JSON.stringify(otlpBody([aSpan(0)], { name: 'a', version: 'b' }))).not.toContain(
      'secret-token',
    );
  });
});
