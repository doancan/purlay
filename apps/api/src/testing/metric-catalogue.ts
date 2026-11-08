/**
 * Every metric family `/metrics` can carry, listed from the code that makes them (D-221): name, type, the labels that tell its
 * series apart, and its help.
 *
 * The documents' catalogue is written from this (`cli/docs-sync.ts`) and the names the documents and the alert rules use are
 * held to it (`metric-catalogue.test.ts`). A family comes from the registry (what is counted in the process, whatever the
 * labels' values), from the application (the gauge of open sockets, registered once it has them) or from a reader of the
 * database that is asked at each scrape (the jobs' record, the outbox, the modules this process runs); those are made here
 * with one example reading each, since only the shape is wanted.
 */
import { jobFamilies } from '../modules/jobs/metrics';
import type { MetricFamily } from '../platform/exposition';
import {
  moduleSuspendedFamily,
  modulesInfoFamily,
  serverMetrics,
  WEBSOCKET_CONNECTIONS,
} from '../platform/metrics';
import { outboxFamilies } from '../platform/outbox-report';

export interface MetricEntry {
  readonly name: string;
  readonly type: MetricFamily['type'];
  /** The names of the labels a series carries, in the order declared. */
  readonly labels: readonly string[];
  readonly help: string;
}

const labelsOfSamples = (family: MetricFamily): string[] => [
  ...new Set(family.samples.flatMap((sample) => Object.keys(sample.labels))),
];

export const metricCatalogue = (): readonly MetricEntry[] => {
  const metrics = serverMetrics();
  metrics.registry.gauge(WEBSOCKET_CONNECTIONS.name, WEBSOCKET_CONNECTIONS.help, () => 0);
  const declared = metrics.registry.declaredLabels();
  const fromRegistry = metrics.registry.families().map((family): MetricEntry => ({
    name: family.name,
    type: family.type,
    labels: declared.get(family.name) ?? [],
    help: family.help,
  }));
  const job = 'example';
  const read = [
    modulesInfoFamily(['example']),
    moduleSuspendedFamily(['example'], new Set()),
    ...jobFamilies(
      [job],
      [{ job_name: job, last_success_at: new Date(0), consecutive_failures: 0 }],
      () => 'example',
    ),
    ...outboxFamilies([{ consumer: 'example', pending: 0, oldestPendingSeconds: 0, dead: 0 }]),
  ].map((family): MetricEntry => ({
    name: family.name,
    type: family.type,
    labels: labelsOfSamples(family),
    help: family.help,
  }));
  return [...fromRegistry, ...read];
};

/** Things named `purlay_…` that are not metrics: database functions, cookies and files the documents also mention. */
const NOT_A_METRIC = new Set([
  'purlay_before_restore_',
  'purlay_demo',
  'purlay_e2e',
  'purlay_fold',
  'purlay_invite',
  'purlay_oauth_state',
  'purlay_restore',
  'purlay_session',
  'purlay_setup',
  'purlay_signin_retry',
  'purlay_template',
  'purlay_two_factor',
]);
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

/**
 * The `purlay_…` words of a text that name no metric of the catalogue: a metric renamed in the code and not in the text, or the
 * other way. A word that ends in `_` is a prefix (`purlay_job_…`), and a histogram may be named by a series (`…_bucket`).
 */
export const unknownMetricReferences = (text: string): string[] => {
  const known = new Set(metricCatalogue().map(({ name }) => name));
  const accepted = (word: string): boolean =>
    known.has(word) ||
    NOT_A_METRIC.has(word) ||
    HISTOGRAM_SUFFIXES.some(
      (suffix) => word.endsWith(suffix) && known.has(word.slice(0, -suffix.length)),
    ) ||
    (word.endsWith('_') && [...known].some((name) => name.startsWith(word)));
  return [...new Set(text.match(/\bpurlay_[a-z0-9_]+/g) ?? [])].filter((word) => !accepted(word));
};
