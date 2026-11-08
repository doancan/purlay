/**
 * The metrics the code has, the metrics the documents say it has, and the table between them.
 *
 * `/metrics` is how an operator sees the module platform, and a name in a document or an alert rule that the code no longer
 * has is a graph that stays empty and an alert that never fires. The table in `DEPLOY.md` is written from the code
 * (`bun run docs:sync`, `docs-sync.test.ts` holds it); this holds the two ends: every metric the source declares is in the
 * catalogue, and every metric a document names is in it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { OUTBOX_ATTEMPTS_MAX } from './platform/outbox-drain';
import { metricCatalogue, unknownMetricReferences } from './testing/metric-catalogue';

/** A metric is declared as the name of a family or the first argument of a registry's `counter`, `gauge` or `histogram`. */
const DECLARATION = /(?:name: |\.(?:gauge|counter|histogram)\(\s*)'(purlay_[a-z0-9_]+)'/g;

const declaredInSource = (): string[] =>
  [...new Bun.Glob('apps/api/src/**/*.ts').scanSync('.')]
    .filter((file) => !file.endsWith('.test.ts'))
    .flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(DECLARATION)].map((m) => m[1] ?? ''),
    );

/** The documents that describe the running system; `DECISIONS.md` and the changelog keep what was true on their dates. */
const DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  ...[...new Bun.Glob('docs/*.md').scanSync('.')].filter((file) => file !== 'docs/DECISIONS.md'),
];

describe('the metric catalogue', () => {
  test('lists every metric the source declares, and no other', () => {
    const catalogue = metricCatalogue().map(({ name }) => name);
    expect(declaredInSource().length).toBeGreaterThan(15);
    expect(new Set(catalogue)).toEqual(new Set(declaredInSource()));
    expect(catalogue.length).toBe(new Set(catalogue).size);
  });

  test.each(DOCUMENTS)('%s names no metric the code does not have', (file) => {
    expect({ file, unknown: unknownMetricReferences(readFileSync(file, 'utf8')) }).toEqual({
      file,
      unknown: [],
    });
  });

  test('a name the code does not have is found, and a histogram series is not one', () => {
    expect(
      unknownMetricReferences(
        '`purlay_outbox_pendin` and `purlay_http_request_duration_seconds_bucket`',
      ),
    ).toEqual(['purlay_outbox_pendin']);
  });

  test('a help string does not carry a copy of a limit the code owns', () => {
    const help =
      metricCatalogue().find(({ name }) => name === 'purlay_outbox_failures_total')?.help ?? '';
    expect(help).toContain(`fails ${String(OUTBOX_ATTEMPTS_MAX)} times`);
  });
});
