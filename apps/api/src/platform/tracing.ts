/**
 * Traces across a request, a job and the delivery of a fact (#1307, D-336): W3C Trace Context in, a span for each of the three, and
 * OTLP/HTTP JSON out to a collector the operator names. Written here and not taken from an SDK: the SDK's memory is what the idle
 * budget (`PRD.md` §5) has least of, and what is needed is small. **Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**: no span is
 * made, nothing is stored, nothing is sent, and the cost of a call is a comparison.
 *
 * **What a span says is chosen here and nowhere else**: the names below, set by our code from values we hold (a route's pattern, a
 * status, a module id, a fact's type, a job's name). Never a path with its ids, a query, a header, a body, a payload, a person or a
 * workspace: a span goes to a system the workspace's members never agreed to. `ATTRIBUTES` is the whole list.
 *
 * **State, said**: the queue of ended spans is the process's own and in memory, bounded (`QUEUE_MAX`, the oldest dropped and counted);
 * a restart loses what it held, which is a few seconds of spans. One export is in flight at a time and a failed one is dropped, never
 * retried, so a collector that is down costs a request nothing and the process a counter.
 */
import type { Clock } from './clock';

/** What one span of a trace is, on the wire of `traceparent`: 32 and 16 lowercase hex digits and whether it is recorded. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** A `traceparent` header as the specification reads it (version 00, not all zeros), or `undefined` for anything else. */
export const parseTraceparent = (header: string | null | undefined): TraceContext | undefined => {
  if (header === null || header === undefined) return undefined;
  const found = TRACEPARENT.exec(header.trim());
  if (found === null) return undefined;
  const [, version, traceId, spanId, flags] = found;
  if (version === undefined || traceId === undefined || spanId === undefined || flags === undefined)
    return undefined;
  // `ff` is not a version; a later version is read by its first fields as the first is, and ours is the one that is written.
  if (version === 'ff' || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  if (version === '00' && header.trim().length !== 55) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
};

export const formatTraceparent = (context: TraceContext): string =>
  `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;

const hex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/** Random ids that are never all zeros, which the specification forbids. */
const newTraceId = (): string => {
  const id = hex(16);
  return id === ZERO_TRACE ? newTraceId() : id;
};
const newSpanId = (): string => {
  const id = hex(8);
  return id === ZERO_SPAN ? newSpanId() : id;
};

/** Whether a trace of this id is recorded at this ratio: the same answer on every node, from the id's own digits. */
export const sampledAt = (traceId: string, ratio: number): boolean => {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return Number.parseInt(traceId.slice(16, 24), 16) / 0x1_0000_0000 < ratio;
};

/** The attributes a span may carry, and what each is: the whole list (`tracing.test.ts` holds it). */
export const ATTRIBUTES = {
  'http.request.method': 'string',
  'http.route': 'string',
  'http.response.status_code': 'number',
  'purlay.module': 'string',
  'purlay.fact.type': 'string',
  'purlay.fact.consumer': 'string',
  'purlay.fact.outcome': 'string',
  'purlay.job': 'string',
} as const;

type AttributeName = keyof typeof ATTRIBUTES;
type AttributeValue = string | number;

type SpanKind = 'server' | 'internal' | 'consumer';
const KIND_CODE: Readonly<Record<SpanKind, number>> = { internal: 1, server: 2, consumer: 5 };

export interface Span {
  /** What a child, or a row written in this span's transaction, carries on: the trace and this span. */
  readonly context: TraceContext;
  readonly recording: boolean;
  readonly setAttribute: (name: AttributeName, value: AttributeValue) => void;
  /** `error` for what the person was refused for the server's fault; a refusal of theirs is not one. */
  readonly setError: () => void;
  readonly end: () => void;
}

export interface Tracer {
  readonly enabled: boolean;
  readonly start: (
    name: string,
    options?: {
      readonly parent?: TraceContext | undefined;
      readonly kind?: SpanKind;
    },
  ) => Span;
}

/** A span nothing records and nothing sends: what a call returns where tracing is off or the trace is not sampled. */
const unrecorded = (context: TraceContext): Span => ({
  context,
  recording: false,
  setAttribute: () => undefined,
  setError: () => undefined,
  end: () => undefined,
});

const NO_CONTEXT: TraceContext = { traceId: ZERO_TRACE, spanId: ZERO_SPAN, sampled: false };

/** The tracer of a process where tracing is off: every call is one comparison. */
export const noTracer: Tracer = {
  enabled: false,
  start: () => unrecorded(NO_CONTEXT),
};

/** One ended span, as the exporter holds it until the next export. */
export interface EndedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly startUnixNano: bigint;
  readonly endUnixNano: bigint;
  readonly attributes: ReadonlyMap<AttributeName, AttributeValue>;
  readonly error: boolean;
}

/** Where ended spans go. */
export interface SpanSink {
  readonly accept: (span: EndedSpan) => void;
}

export const createTracer = (options: {
  readonly sink: SpanSink;
  readonly clock: Clock;
  /** The share of traces recorded when none is inherited, 0 to 1 (`TRACE_SAMPLE_RATIO`). A trace that arrives with a decision keeps it. */
  readonly sampleRatio: number;
}): Tracer => {
  const { sink, clock, sampleRatio } = options;
  return {
    enabled: true,
    start: (name, startOptions = {}): Span => {
      const { parent, kind = 'internal' } = startOptions;
      const traceId = parent?.traceId ?? newTraceId();
      const sampled = parent === undefined ? sampledAt(traceId, sampleRatio) : parent.sampled;
      const context: TraceContext = { traceId, spanId: newSpanId(), sampled };
      // Not recorded: the context still travels, so a child decides as its parent did, and nothing else is spent.
      if (!sampled) return unrecorded(context);
      const startedAt = BigInt(clock.now().getTime()) * 1_000_000n;
      const startedClock = performance.now();
      const attributes = new Map<AttributeName, AttributeValue>();
      let ended = false;
      let error = false;
      return {
        context,
        recording: true,
        setAttribute: (attribute, value): void => {
          // A name that is not on the list is a defect of the caller; it is never sent.
          if (typeof value === ATTRIBUTES[attribute]) attributes.set(attribute, value);
        },
        setError: (): void => {
          error = true;
        },
        end: (): void => {
          if (ended) return;
          ended = true;
          const elapsed = BigInt(
            Math.max(0, Math.round((performance.now() - startedClock) * 1_000_000)),
          );
          sink.accept({
            name,
            kind,
            traceId,
            spanId: context.spanId,
            parentSpanId: parent?.spanId,
            startUnixNano: startedAt,
            endUnixNano: startedAt + elapsed,
            attributes,
            error,
          });
        },
      };
    },
  };
};

/** The tracer the process runs with: set once at start, read wherever a span is made. Off until `useTracer` says otherwise. */
let current: Tracer = noTracer;

export const tracer = (): Tracer => current;

/** Sets the process's tracer and answers the one it replaces, so a test puts it back. */
export const useTracer = (next: Tracer): Tracer => {
  const before = current;
  current = next;
  return before;
};

/** The unit of the sink's counters: what became of a span. */
export type SpanOutcome = 'exported' | 'dropped' | 'failed';

export interface OtlpOptions {
  readonly endpoint: string;
  /** Sent with every export: a collector's credential, which is never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly fetch: typeof fetch;
  readonly counted: (outcome: SpanOutcome, spans: number) => void;
  readonly batchMax?: number;
  readonly queueMax?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/** Ended spans held for the next export. */
export const QUEUE_MAX = 2_048;
const BATCH_MAX = 512;
const INTERVAL_MS = 5_000;
const TIMEOUT_MS = 3_000;

const attributeOf = (
  key: string,
  value: AttributeValue,
): { key: string; value: { stringValue: string } | { intValue: string } } => ({
  key,
  value:
    typeof value === 'number' ? { intValue: String(Math.trunc(value)) } : { stringValue: value },
});

/** The body of one export: OTLP's JSON encoding of traces, 64-bit numbers as strings as it asks. */
export const otlpBody = (
  spans: readonly EndedSpan[],
  service: { readonly name: string; readonly version: string },
): unknown => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          attributeOf('service.name', service.name),
          attributeOf('service.version', service.version),
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'purlay' },
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
            name: span.name,
            kind: KIND_CODE[span.kind],
            startTimeUnixNano: String(span.startUnixNano),
            endTimeUnixNano: String(span.endUnixNano),
            attributes: [...span.attributes].map(([key, value]) => attributeOf(key, value)),
            status: { code: span.error ? 2 : 1 },
          })),
        },
      ],
    },
  ],
});

/**
 * Batches ended spans and posts them to `<endpoint>/v1/traces`. A queue that is full drops its oldest span; a post that fails, or is
 * not answered within the timeout, drops its batch: counted, and never in the way of a request. `flush` is the shutdown's, which
 * gives what is held one last try.
 */
export const createOtlpSink = (
  options: OtlpOptions,
): SpanSink & { readonly flush: () => Promise<void>; readonly stop: () => void } => {
  const {
    endpoint,
    headers,
    serviceName,
    serviceVersion,
    counted,
    batchMax = BATCH_MAX,
    queueMax = QUEUE_MAX,
    intervalMs = INTERVAL_MS,
    timeoutMs = TIMEOUT_MS,
  } = options;
  const url = `${endpoint.replace(/\/+$/, '')}/v1/traces`;
  const queue: EndedSpan[] = [];
  let posting: Promise<void> | undefined;

  const post = async (): Promise<void> => {
    if (posting !== undefined) {
      await posting;
      return;
    }
    const batch = queue.splice(0, batchMax);
    if (batch.length === 0) return;
    posting = (async (): Promise<void> => {
      try {
        const answer = await options.fetch(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(otlpBody(batch, { name: serviceName, version: serviceVersion })),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        // The body is not read: a collector's words are its own and may repeat what was sent.
        void answer.body?.cancel();
        counted(answer.ok ? 'exported' : 'failed', batch.length);
      } catch {
        counted('failed', batch.length);
      } finally {
        posting = undefined;
      }
    })();
    await posting;
  };

  const timer = setInterval(() => {
    void post();
  }, intervalMs);
  timer.unref();

  return {
    accept: (span): void => {
      if (queue.length >= queueMax) {
        queue.shift();
        counted('dropped', 1);
      }
      queue.push(span);
      if (queue.length >= batchMax) void post();
    },
    flush: async (): Promise<void> => {
      // Until nothing is held and nothing is on its way: a post in flight is waited for, and the rest is posted after it. Every post
      // takes a batch out of the queue, win or lose, so this ends.
      for (;;) {
        if (posting !== undefined) {
          await posting;
        } else if (queue.length === 0) {
          return;
        } else {
          await post();
        }
      }
    },
    stop: (): void => {
      clearInterval(timer);
    },
  };
};
