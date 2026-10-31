/**
 * What this process counts for `/metrics` (D-221): one registry per process, made by the composition
 * root and handed to what records into it, as every other dependency is.
 *
 * - **Recorded at the boundaries.** The HTTP edge observes each request, the socket counts what its
 *   limiter refused, the push sender and the mail outbox count what they could not deliver. A module
 *   is handed a `Counter`, never the registry, so what it may write is one line it was given.
 * - **No label carries anything a person wrote or is.** Every label value is one of a short list the
 *   code spells — a method, a route as registered, a status class, a reason — never a path as sent,
 *   an id, an address or a name: the series stay few, and the page is no log of who did what.
 * - **Counted in this process.** Several nodes are several scrapes; Prometheus adds them up.
 */
import {
  exposition,
  isLabelName,
  isMetricName,
  type MetricFamily,
  type Sample,
} from './exposition';

/** The values of a series' labels, one per name the family declared. */
type LabelValues<L extends string> = Readonly<Record<L, string>>;

export interface Counter<L extends string = never> {
  /** Adds `by` (one, by default) to the series these labels name. Never down: a counter only rises. */
  readonly inc: (labels: LabelValues<L>, by?: number) => void;
}

interface Histogram<L extends string = never> {
  readonly observe: (labels: LabelValues<L>, value: number) => void;
}

export interface MetricsRegistry {
  readonly counter: <L extends string = never>(
    name: string,
    help: string,
    labelNames: readonly L[],
  ) => Counter<L>;
  readonly histogram: <L extends string = never>(
    name: string,
    help: string,
    labelNames: readonly L[],
    buckets: readonly number[],
  ) => Histogram<L>;
  /** A value read when the page is asked for, not kept: what is open now, how long it has run. */
  readonly gauge: (name: string, help: string, read: () => number) => void;
  /** Every family, in the order declared, as it stands now. */
  readonly families: () => readonly MetricFamily[];
}

interface Series {
  readonly labels: Readonly<Record<string, string>>;
  value: number;
}

interface HistogramSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly counts: number[];
  sum: number;
  count: number;
}

/** The labels in their declared order, refused when one is missing or one was never declared. */
const labelsOf = (
  family: string,
  labelNames: readonly string[],
  given: Readonly<Record<string, string>>,
): { readonly key: string; readonly labels: Readonly<Record<string, string>> } => {
  const names = Object.keys(given);
  if (names.length !== labelNames.length || !labelNames.every((name) => name in given)) {
    throw new Error(`${family}: labels must be exactly ${labelNames.join(', ') || 'none'}`);
  }
  const labels = Object.fromEntries(labelNames.map((name) => [name, given[name] ?? '']));
  return { key: JSON.stringify(labelNames.map((name) => labels[name])), labels };
};

export const createMetricsRegistry = (): MetricsRegistry => {
  const collectors: (() => MetricFamily)[] = [];
  const declared = new Set<string>();

  const declare = (name: string, labelNames: readonly string[]): void => {
    if (!isMetricName(name)) throw new Error(`not a metric name: ${name}`);
    const invalid = labelNames.filter((label) => !isLabelName(label) || label === 'le');
    if (invalid.length > 0) throw new Error(`${name}: not a label name: ${invalid.join(', ')}`);
    // Two families of one name would be one Prometheus refuses to read: refused here, at start.
    if (declared.has(name)) throw new Error(`a metric is declared twice: ${name}`);
    declared.add(name);
  };

  return {
    counter: <L extends string = never>(
      name: string,
      help: string,
      labelNames: readonly L[],
    ): Counter<L> => {
      declare(name, labelNames);
      const series = new Map<string, Series>();
      collectors.push(() => ({
        name,
        help,
        type: 'counter',
        samples: [...series.values()].map((one) => ({
          suffix: '',
          labels: one.labels,
          value: one.value,
        })),
      }));
      return {
        inc: (given, by = 1): void => {
          if (!Number.isFinite(by) || by < 0) {
            throw new Error(`${name}: a counter rises by a finite amount, never down`);
          }
          const { key, labels } = labelsOf(name, labelNames, given);
          const one = series.get(key);
          if (one === undefined) series.set(key, { labels, value: by });
          else one.value += by;
        },
      };
    },

    histogram: <L extends string = never>(
      name: string,
      help: string,
      labelNames: readonly L[],
      buckets: readonly number[],
    ): Histogram<L> => {
      declare(name, labelNames);
      if (
        buckets.length === 0 ||
        buckets.some(
          (bound, at) => !Number.isFinite(bound) || (at > 0 && bound <= (buckets[at - 1] ?? bound)),
        )
      ) {
        throw new Error(`${name}: buckets must be finite and rising`);
      }
      const series = new Map<string, HistogramSeries>();
      collectors.push(() => ({
        name,
        help,
        type: 'histogram',
        samples: [...series.values()].flatMap((one): Sample[] => [
          // Cumulative, as the format reads them: each bucket holds every one at or below it.
          ...buckets.map((bound, at) => ({
            suffix: '_bucket',
            labels: { ...one.labels, le: String(bound) },
            value: one.counts.slice(0, at + 1).reduce((total, count) => total + count, 0),
          })),
          { suffix: '_bucket', labels: { ...one.labels, le: '+Inf' }, value: one.count },
          { suffix: '_sum', labels: one.labels, value: one.sum },
          { suffix: '_count', labels: one.labels, value: one.count },
        ]),
      }));
      return {
        observe: (given, value): void => {
          if (!Number.isFinite(value)) throw new Error(`${name}: an observation must be finite`);
          const { key, labels } = labelsOf(name, labelNames, given);
          let one = series.get(key);
          if (one === undefined) {
            one = { labels, counts: buckets.map(() => 0), sum: 0, count: 0 };
            series.set(key, one);
          }
          const bucket = buckets.findIndex((bound) => value <= bound);
          if (bucket !== -1) one.counts[bucket] = (one.counts[bucket] ?? 0) + 1;
          one.sum += value;
          one.count += 1;
        },
      };
    },

    gauge: (name, help, read): void => {
      declare(name, []);
      collectors.push(() => ({
        name,
        help,
        type: 'gauge',
        samples: [{ suffix: '', labels: {}, value: read() }],
      }));
    },

    families: () => collectors.map((collect) => collect()),
  };
};

/**
 * How long a request took, in seconds. Prometheus's own default buckets: they span a cached read
 * (a few milliseconds) to a request that is about to time out, and a dashboard built for any other
 * service reads them without translation.
 */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Which door a refusal for the rate came through. */
type RateDoor = 'http' | 'socket';

/** Why a push did not reach its service (`modules/push/sender.ts`). */
export type PushFailure = 'refused' | 'not_taken' | 'error' | 'dropped';

const PUSH_FAILURES: readonly PushFailure[] = ['refused', 'not_taken', 'error', 'dropped'];
const RATE_DOORS: readonly RateDoor[] = ['http', 'socket'];

/** What the process itself is, read when asked: the real process unless a test hands its own. */
export interface ProcessReadings {
  readonly uptimeSeconds: () => number;
  readonly residentBytes: () => number;
}

const thisProcess: ProcessReadings = {
  uptimeSeconds: () => process.uptime(),
  residentBytes: () => process.memoryUsage().rss,
};

/** The instruments the server records into, each declared once with its help. */
export interface ServerMetrics {
  readonly registry: MetricsRegistry;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly rateLimited: Counter<'door'>;
  readonly pushFailures: Counter<'reason'>;
  readonly mailFailures: Counter;
}

export const serverMetrics = (readings: ProcessReadings = thisProcess): ServerMetrics => {
  const registry = createMetricsRegistry();
  registry.gauge(
    'purlay_process_uptime_seconds',
    'Seconds since this process started.',
    readings.uptimeSeconds,
  );
  registry.gauge(
    'purlay_process_resident_memory_bytes',
    'Resident memory of this process, in bytes.',
    readings.residentBytes,
  );
  const httpDuration = registry.histogram(
    'purlay_http_request_duration_seconds',
    'HTTP requests answered by this process, by method, route as registered and status class; _count is the number of requests.',
    ['method', 'route', 'status'],
    HTTP_DURATION_BUCKETS,
  );
  const rateLimited = registry.counter(
    'purlay_rate_limited_total',
    'Requests and socket frames refused for the rate, by the door they came through.',
    ['door'],
  );
  const pushFailures = registry.counter(
    'purlay_push_failures_total',
    'Web Push deliveries that did not reach their push service, by reason.',
    ['reason'],
  );
  const mailFailures = registry.counter(
    'purlay_mail_failures_total',
    'Letters the mail relay did not accept.',
    [],
  );
  // Every series a counter can have is there from the start, at zero: a rate over a series that
  // appears only with its first failure misses that failure.
  for (const door of RATE_DOORS) rateLimited.inc({ door }, 0);
  for (const reason of PUSH_FAILURES) pushFailures.inc({ reason }, 0);
  mailFailures.inc({}, 0);
  return { registry, httpDuration, rateLimited, pushFailures, mailFailures };
};

/** The page, from what the registry holds and what was read for this scrape alone. */
export const renderMetrics = (metrics: ServerMetrics, read: readonly MetricFamily[] = []): string =>
  exposition([...metrics.registry.families(), ...read]);
