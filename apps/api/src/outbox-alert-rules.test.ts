/**
 * The alert rules of the outbox (`docker/alerts/purlay-outbox.rules.yml`, D-288 §12) are code, so they are held to the code: every
 * metric a rule names is one the code has (a metric renamed breaks this and not the alert silently), each rule says what to do and
 * is in the thresholds table of `DEPLOY.md`, and the stale threshold is the overview's own.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { OUTBOX_STALE_AFTER_SECONDS } from './platform/outbox-report';
import { unknownMetricReferences } from './testing/metric-catalogue';

const FILE = 'docker/alerts/purlay-outbox.rules.yml';

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: { readonly severity: string };
  readonly annotations: { readonly summary: string; readonly runbook: string };
}

const rules = (): readonly Rule[] =>
  (Bun.YAML.parse(readFileSync(FILE, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap(
    (group) => group.rules,
  );

describe('the outbox alert rules', () => {
  test('there are rules, each with an expression, a wait, a severity and a place in the runbook', () => {
    expect(rules().length).toBeGreaterThanOrEqual(8);
    for (const rule of rules()) {
      expect(rule.alert).toMatch(/^Purlay[A-Za-z]+$/);
      expect(rule.expr.trim().length).toBeGreaterThan(0);
      expect(rule.for).toMatch(/^\d+[ms]$/);
      expect(['warning', 'page']).toContain(rule.labels.severity);
      expect(rule.annotations.summary.length).toBeGreaterThan(0);
      expect(rule.annotations.runbook).toContain('docs/DEPLOY.md');
    }
    const names = rules().map(({ alert }) => alert);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every metric a rule names is one the code has, and each rule names one', () => {
    expect(unknownMetricReferences(readFileSync(FILE, 'utf8'))).toEqual([]);
    for (const rule of rules()) expect(rule.expr).toMatch(/\bpurlay_[a-z0-9_]+/);
  });

  test('the metric check would see a rename: a name the code does not have is found in a rule', () => {
    expect(unknownMetricReferences('max by (module) (purlay_outbox_dead_facts) > 0')).toEqual([
      'purlay_outbox_dead_facts',
    ]);
  });

  test('the stale threshold is the overview’s fifteen minutes', () => {
    const stale = rules().find(({ alert }) => alert === 'PurlayOutboxOldestPendingStale');
    expect(stale?.expr).toContain(`> ${String(OUTBOX_STALE_AFTER_SECONDS)}`);
  });

  test('every alert is in the thresholds table of DEPLOY.md, and the runbook sections the rules point to exist', () => {
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8');
    for (const rule of rules()) expect(deploy).toContain(`\`${rule.alert}\``);
    for (const rule of rules()) {
      const title = /"([^"]+)"/.exec(rule.annotations.runbook)?.[1] ?? '';
      expect(deploy).toMatch(new RegExp(`^#+ ${title}|^\\*\\*${title}`, 'm'));
    }
  });
});
