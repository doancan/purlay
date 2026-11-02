/**
 * A strict reader of Prometheus's text format (0.0.4), for the tests of what `/metrics` writes: a
 * second spelling of the grammar, written from the format's description rather than from the writer,
 * so a page the writer gets wrong is one this refuses (D-221).
 *
 * It refuses a line that is not a comment, a HELP, a TYPE or a sample; a sample before its family's
 * TYPE; a family typed twice; a label value with an unescaped quote or line break; and a page that
 * does not end with a line break.
 */

interface ReadSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface ReadPage {
  readonly types: ReadonlyMap<string, string>;
  readonly samples: readonly ReadSample[];
}

const NAME = '[a-zA-Z_:][a-zA-Z0-9_:]*';
const LABEL = '[a-zA-Z_][a-zA-Z0-9_]*';
const VALUE_TEXT = String.raw`"(?:[^"\\\n]|\\[\\"n])*"`;
const SAMPLE = new RegExp(
  `^(${NAME})(?:\\{((?:${LABEL}=${VALUE_TEXT})(?:,${LABEL}=${VALUE_TEXT})*)?\\})? (\\S+)$`,
);
const PAIR = new RegExp(`(${LABEL})=(${VALUE_TEXT})`, 'g');
const NUMBER = /^(?:[+-]?Inf|NaN|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;
const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);

const unescape = (quoted: string): string =>
  quoted
    .slice(1, -1)
    .replace(/\\([\\"n])/g, (_match, escaped: string) => (escaped === 'n' ? '\n' : escaped));

const numberOf = (text: string): number => {
  if (!NUMBER.test(text)) throw new Error(`not a sample value: ${text}`);
  if (text === 'NaN') return Number.NaN;
  if (text.endsWith('Inf')) return text.startsWith('-') ? -Infinity : Infinity;
  return Number(text);
};

/** The family a sample belongs to: its own name, or a histogram's without the suffix. */
const familyOf = (name: string, types: ReadonlyMap<string, string>): string | undefined => {
  if (types.has(name)) return name;
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return types.get(base) === 'histogram' ? base : undefined;
};

export const readExposition = (page: string): ReadPage => {
  if (page !== '' && !page.endsWith('\n')) throw new Error('the page must end with a line break');
  const types = new Map<string, string>();
  const samples: ReadSample[] = [];
  for (const line of page.split('\n').slice(0, -1)) {
    const type = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (type !== null) {
      const [, name = '', kind = ''] = type;
      if (!TYPES.has(kind)) throw new Error(`not a metric type: ${kind}`);
      if (types.has(name)) throw new Error(`typed twice: ${name}`);
      types.set(name, kind);
      continue;
    }
    if (line.startsWith('#')) continue;
    const sample = SAMPLE.exec(line);
    if (sample === null) throw new Error(`not a sample line: ${line}`);
    const [, name = '', pairs = '', value = ''] = sample;
    if (familyOf(name, types) === undefined) throw new Error(`a sample before its TYPE: ${name}`);
    const labels = Object.fromEntries(
      [...pairs.matchAll(PAIR)].map(([, label = '', quoted = '']) => [label, unescape(quoted)]),
    );
    samples.push({ name, labels, value: numberOf(value) });
  }
  return { types, samples };
};

/** The one sample of this name with exactly these labels among those given, or undefined. */
export const sampleOf = (
  page: ReadPage,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number | undefined =>
  page.samples.find(
    (sample) =>
      sample.name === name &&
      Object.keys(sample.labels).length === Object.keys(labels).length &&
      Object.entries(labels).every(([label, value]) => sample.labels[label] === value),
  )?.value;
