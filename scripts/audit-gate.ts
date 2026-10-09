/**
 * The dependency audit as a gate, not a report (#247, D-77).
 *
 * `bun audit` prints findings and, run bare, the pipeline would only be as strict
 * as someone reading its output. The gate blocks at high severity — and for a
 * finding that has no fix, the only way past is an entry in
 * `audit-allowlist.json` that names the advisory, gives a reason, and **expires**.
 * Three things keep that list from becoming the place findings are forgotten:
 *
 * - an entry past its date fails the run, even though the finding is still there;
 * - an entry that matches no current finding fails the run, so a fix removes its
 *   own exception;
 * - an expiry further out than `MAX_ALLOWANCE_DAYS` fails, because a date in 2099
 *   is not an expiry.
 *
 * The functions here are pure; `audit.ts` runs `bun audit --json`, supplies today's
 * date (the clock is a dependency, D-46) and exits.
 */

/** Severities that block. Anything the audit reports that is not known is treated as blocking. */
const NON_BLOCKING = new Set(['low', 'moderate']);

export const MAX_ALLOWANCE_DAYS = 180;

export interface Finding {
  readonly advisory: string;
  readonly package: string;
  readonly severity: string;
}

export interface Allowance {
  readonly advisory: string;
  readonly package: string;
  readonly reason: string;
  /** An ISO date, `YYYY-MM-DD`. The last day the allowance holds. */
  readonly expires: string;
}

export interface Verdict {
  readonly ok: boolean;
  /** What fails the run. */
  readonly problems: readonly string[];
  /** What passes but should stay visible. */
  readonly notes: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON: ${JSON.stringify(text.slice(0, 200))}`);
  }
};

/** An advisory id from the URL `bun audit` prints, e.g. `.../advisories/GHSA-xxxx-xxxx-xxxx`. */
const ADVISORY_ID = /GHSA(?:-[0-9a-z]{4}){3}/;

/**
 * The findings in `bun audit --json`: an object of package name to advisories.
 * Throws on anything else — an audit that printed nothing, or an error message,
 * must not be read as "no findings" (CONTRIBUTING §6.4).
 */
export const parseAudit = (text: string): readonly Finding[] => {
  const report = parseJson(text, 'the audit output');
  if (!isRecord(report))
    throw new Error('the audit output has an unexpected shape (not an object)');

  return Object.entries(report).flatMap(([name, advisories]) => {
    if (!Array.isArray(advisories)) {
      throw new Error(`the audit output has an unexpected shape for ${name}`);
    }
    return advisories.map((item: unknown): Finding => {
      const url = isRecord(item) ? item['url'] : undefined;
      const severity = isRecord(item) ? item['severity'] : undefined;
      const id = typeof url === 'string' ? ADVISORY_ID.exec(url)?.[0] : undefined;
      if (id === undefined || typeof severity !== 'string') {
        throw new Error(`an advisory for ${name} carries no advisory id or severity`);
      }
      return { advisory: id, package: name, severity };
    });
  });
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from one ISO date to another. Parses a calendar date; it never asks what time it is. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const parseAllowlist = (text: string): readonly Allowance[] => {
  const list = parseJson(text, 'the allowlist');
  if (!Array.isArray(list)) throw new Error('the allowlist must be an array');

  return list.map((item: unknown, index): Allowance => {
    const field = (name: string): string => {
      const value = isRecord(item) ? item[name] : undefined;
      return typeof value === 'string' ? value.trim() : '';
    };
    const where = `allowlist entry ${String(index + 1)}`;
    if (!ADVISORY_ID.test(field('advisory'))) {
      throw new Error(`${where}: advisory must be a GHSA id`);
    }
    if (field('package') === '') throw new Error(`${where}: package is required`);
    if (field('reason') === '') throw new Error(`${where}: a reason is required`);
    if (!ISO_DATE.test(field('expires')) || Number.isNaN(Date.parse(field('expires')))) {
      throw new Error(`${where}: expires must be a date, YYYY-MM-DD`);
    }
    return {
      advisory: field('advisory'),
      package: field('package'),
      reason: field('reason'),
      expires: field('expires'),
    };
  });
};

export const judgeAudit = ({
  findings,
  allowlist,
  today,
}: {
  readonly findings: readonly Finding[];
  readonly allowlist: readonly Allowance[];
  /** `YYYY-MM-DD`, supplied by the caller. */
  readonly today: string;
}): Verdict => {
  const problems: string[] = [];
  const notes: string[] = [];
  const blocking = findings.filter((finding) => !NON_BLOCKING.has(finding.severity));

  for (const finding of findings) {
    if (NON_BLOCKING.has(finding.severity)) {
      notes.push(
        `${finding.severity}: ${finding.package} ${finding.advisory} (below the threshold)`,
      );
    }
  }

  for (const finding of blocking) {
    const allowance = allowlist.find(
      (candidate) =>
        candidate.advisory === finding.advisory && candidate.package === finding.package,
    );
    if (allowance === undefined) {
      problems.push(
        `${finding.severity}: ${finding.package} ${finding.advisory} is not fixed and not allowed`,
      );
    } else if (allowance.expires < today) {
      problems.push(
        `${finding.package} ${finding.advisory}: the allowance expired on ${allowance.expires}; fix it or review and renew it`,
      );
    } else {
      notes.push(
        `${finding.severity}: ${finding.package} ${finding.advisory} allowed until ${allowance.expires}: ${allowance.reason}`,
      );
    }
  }

  for (const allowance of allowlist) {
    const matches = blocking.some(
      (finding) => finding.advisory === allowance.advisory && finding.package === allowance.package,
    );
    if (!matches) {
      problems.push(
        `allowlist: ${allowance.package} ${allowance.advisory} matches no finding; remove the entry`,
      );
    }
    if (daysBetween(today, allowance.expires) > MAX_ALLOWANCE_DAYS) {
      problems.push(
        `allowlist: ${allowance.advisory} expires more than ${String(MAX_ALLOWANCE_DAYS)} days from now; renew in shorter steps`,
      );
    }
  }

  return { ok: problems.length === 0, problems, notes };
};
