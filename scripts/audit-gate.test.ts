import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeAudit, parseAudit, parseAllowlist, MAX_ALLOWANCE_DAYS } from './audit-gate';

const TODAY = '2026-10-09';

const advisory = (id: string, severity: string, name = 'braces'): Record<string, unknown[]> => ({
  [name]: [
    {
      id: 1,
      url: `https://github.com/advisories/${id}`,
      title: 'a title',
      severity,
      vulnerable_versions: '<=1.0.0',
    },
  ],
});

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  advisory: 'GHSA-aaaa-bbbb-cccc',
  package: 'braces',
  reason: 'no patched release exists; reachable only from a development tool',
  expires: '2026-12-31',
  ...overrides,
});

describe('parseAudit', () => {
  test('reads advisories out of bun audit --json, one finding per advisory', () => {
    const findings = parseAudit(
      JSON.stringify({
        ...advisory('GHSA-aaaa-bbbb-cccc', 'high'),
        ...advisory('GHSA-dddd-eeee-ffff', 'moderate', 'x'),
      }),
    );
    expect(findings).toEqual([
      { advisory: 'GHSA-aaaa-bbbb-cccc', package: 'braces', severity: 'high' },
      { advisory: 'GHSA-dddd-eeee-ffff', package: 'x', severity: 'moderate' },
    ]);
  });

  test('an empty object is a clean tree, but empty output is not a report', () => {
    expect(parseAudit('{}')).toEqual([]);
    // Nothing printed is what a crashed audit looks like, and it must not read as clean.
    expect(() => parseAudit('')).toThrow(/not JSON/);
    expect(() => parseAudit('error: network unreachable')).toThrow(/not JSON/);
  });

  test('a shape it does not recognise is an error rather than "no findings"', () => {
    expect(() => parseAudit('[1,2]')).toThrow(/unexpected/);
    expect(() => parseAudit(JSON.stringify({ braces: [{ severity: 'high' }] }))).toThrow(
      /advisory/,
    );
  });
});

describe('parseAllowlist', () => {
  test('accepts a complete entry', () => {
    expect(parseAllowlist(JSON.stringify([entry()]))).toHaveLength(1);
  });

  test('refuses an entry with no reason, no expiry, or an expiry that is not a date', () => {
    expect(() => parseAllowlist(JSON.stringify([entry({ reason: '  ' })]))).toThrow(/reason/);
    expect(() => parseAllowlist(JSON.stringify([entry({ expires: undefined })]))).toThrow(
      /expires/,
    );
    expect(() => parseAllowlist(JSON.stringify([entry({ expires: 'soon' })]))).toThrow(/expires/);
    expect(() => parseAllowlist(JSON.stringify([entry({ advisory: 'CVE-1' })]))).toThrow(
      /advisory/,
    );
  });
});

describe('judgeAudit', () => {
  const high = { advisory: 'GHSA-aaaa-bbbb-cccc', package: 'braces', severity: 'high' };

  test('a high finding nobody allowed fails', () => {
    const verdict = judgeAudit({ findings: [high], allowlist: [], today: TODAY });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('GHSA-aaaa-bbbb-cccc');
  });

  test('critical fails as well, and moderate and low do not block', () => {
    expect(
      judgeAudit({ findings: [{ ...high, severity: 'critical' }], allowlist: [], today: TODAY }).ok,
    ).toBe(false);
    expect(
      judgeAudit({ findings: [{ ...high, severity: 'moderate' }], allowlist: [], today: TODAY }).ok,
    ).toBe(true);
    expect(
      judgeAudit({ findings: [{ ...high, severity: 'low' }], allowlist: [], today: TODAY }).ok,
    ).toBe(true);
  });

  test('an unknown severity fails rather than slipping under the threshold', () => {
    expect(
      judgeAudit({ findings: [{ ...high, severity: 'bad' }], allowlist: [], today: TODAY }).ok,
    ).toBe(false);
  });

  test('an allowed finding passes, and is still reported so the exception is visible', () => {
    const verdict = judgeAudit({
      findings: [high],
      allowlist: parseAllowlist(JSON.stringify([entry()])),
      today: TODAY,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join('\n')).toContain('allowed until 2026-12-31');
  });

  test('an expired allowance fails even though the finding is still there', () => {
    const verdict = judgeAudit({
      findings: [high],
      allowlist: parseAllowlist(JSON.stringify([entry({ expires: '2026-10-08' })])),
      today: TODAY,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('expired on 2026-10-08');
  });

  test('an allowance that matches nothing fails, so fixed findings leave the list', () => {
    const verdict = judgeAudit({
      findings: [],
      allowlist: parseAllowlist(JSON.stringify([entry()])),
      today: TODAY,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('matches no finding');
  });

  test('an allowance further out than the maximum fails: an expiry in 2099 is no expiry', () => {
    const far = '2027-12-31';
    const verdict = judgeAudit({
      findings: [high],
      allowlist: parseAllowlist(JSON.stringify([entry({ expires: far })])),
      today: TODAY,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain(`${String(MAX_ALLOWANCE_DAYS)} days`);
  });
});

describe('the committed allowlist', () => {
  test('is well formed', () => {
    const text = readFileSync(join(import.meta.dir, 'audit-allowlist.json'), 'utf8');
    expect(() => parseAllowlist(text)).not.toThrow();
  });
});
