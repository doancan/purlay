/**
 * Prometheus's text exposition format, version 0.0.4 (D-221): what `/metrics` answers.
 *
 * Written here rather than taken from a client library: the format is a page of rules, and a
 * dependency for a page is the trade `CONTRIBUTING.md` §1.12 asks to be justified. What it renders
 * is decided elsewhere (`metrics.ts`); this only spells it, so it is pure and tested on its own.
 *
 * - **A family is its `# HELP` and `# TYPE` once, then its samples.** HELP escapes a backslash and a
 *   line break; a label value escapes those and a double quote. Nothing else needs escaping.
 * - **A name is checked when it is declared**, so a family the server would render and Prometheus
 *   refuse to read is a failure at start, not a scrape that fails every fifteen seconds.
 */

type MetricType = 'counter' | 'gauge' | 'histogram';

export interface Sample {
  /** Appended to the family's name: `_bucket`, `_sum`, `_count` for a histogram, empty otherwise. */
  readonly suffix: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly samples: readonly Sample[];
}

/** The content type a scraper is told this is. */
export const EXPOSITION_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** A label name, and not one of the `__` names Prometheus keeps for itself. */
const LABEL_NAME = /^(?!__)[a-zA-Z_][a-zA-Z0-9_]*$/;

export const isMetricName = (name: string): boolean => METRIC_NAME.test(name);
export const isLabelName = (name: string): boolean => LABEL_NAME.test(name);

const escapeHelp = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');

const escapeLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

/** A number as Go's parser reads it: the three that are not finite have names of their own. */
export const formatValue = (value: number): string => {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
};

const formatLabels = (labels: Readonly<Record<string, string>>): string => {
  const pairs = Object.entries(labels).map(
    ([name, value]) => `${name}="${escapeLabelValue(value)}"`,
  );
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
};

/** The whole page: every family in the order given, ending with a line break as the format asks. */
export const exposition = (families: readonly MetricFamily[]): string =>
  families
    .map((family) =>
      [
        `# HELP ${family.name} ${escapeHelp(family.help)}`,
        `# TYPE ${family.name} ${family.type}`,
        ...family.samples.map(
          (sample) =>
            `${family.name}${sample.suffix}${formatLabels(sample.labels)} ${formatValue(sample.value)}`,
        ),
      ].join('\n'),
    )
    .map((block) => `${block}\n`)
    .join('');
