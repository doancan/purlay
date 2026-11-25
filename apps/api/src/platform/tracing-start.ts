/**
 * Turns tracing on at the process's start (#1307, D-336): from the configuration, the tracer the rest of the process reads
 * (`tracing.ts`'s `tracer()`), with the exporter behind it and the counters of what became of the spans. Nothing is made where
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. The shutdown gives what is held one last try.
 */
import type { Clock } from './clock';
import { otlpHeaders, type Config } from './config';
import type { ServerMetrics } from './metrics';
import { SERVER_VERSION } from './server-version';
import { createOtlpSink, createTracer, useTracer, type Tracer } from './tracing';

export interface Tracing {
  readonly tracer: Tracer;
  /** Sends what is held and stops the timer: the process is going. Never throws. */
  readonly stop: () => Promise<void>;
}

export const startTracing = (
  config: Pick<
    Config,
    'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS' | 'TRACE_SAMPLE_RATIO'
  >,
  dependencies: {
    readonly clock: Clock;
    readonly metrics: Pick<ServerMetrics, 'traceSpans'>;
    readonly fetch?: typeof fetch;
  },
): Tracing | undefined => {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined) return undefined;
  const sink = createOtlpSink({
    endpoint,
    // Validated at the start (`config.ts`), so this is never the empty answer a malformed value would be.
    headers: otlpHeaders(config) ?? {},
    serviceName: 'purlay-api',
    serviceVersion: SERVER_VERSION,
    fetch: dependencies.fetch ?? fetch,
    counted: (outcome, spans): void => {
      dependencies.metrics.traceSpans.inc({ outcome }, spans);
    },
  });
  const tracer = createTracer({
    sink,
    clock: dependencies.clock,
    sampleRatio: config.TRACE_SAMPLE_RATIO,
  });
  useTracer(tracer);
  return {
    tracer,
    stop: async (): Promise<void> => {
      sink.stop();
      // `flush` cannot reject: a post that fails is counted and its batch dropped (`tracing.ts`).
      await sink.flush();
    },
  };
};
