/**
 * The numbers the documents state, against the constants that enforce them.
 *
 * A reader of `API.md` or `ARCHITECTURE.md` should not have to open the code to
 * learn the page cap or the socket's limits, so the documents say them — and a
 * number in two places is a number that will disagree with itself (#201). The
 * code owns each one; this fails when a document stops matching it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CORE_COLUMNS_FOR_A_MODULE, TABLE_LIFECYCLE } from '@purlay/db';
import { MAX_FRAME_BYTES, PAGE_LIMIT } from '@purlay/types';
import { STARVATION_FACTOR } from './cli/budget-latency';
import { bundledModules } from './composition';
import {
  ISSUES_QUEUE_TIMEOUT_MS,
  ISSUES_STATEMENT_TIMEOUT_MS,
  POOL_SHARE_DIVISOR,
} from './features/issues/budget';
import { AUTH_BUDGET, WRITE_BUDGET } from './ingress/http/rate-limit';
import { JSON_BODY_MAX_BYTES } from './ingress/http/edge';
import { OUTBOX_PENDING_MAX_DEFAULT } from './platform/config';
import { DEFAULT_JOB_DEADLINE_MS } from './modules/jobs/module-shares';
import { OUTBOX_CONSUME_INTERVAL_MS } from './modules/workers/outbox-consumer';
import { CORE_RESERVE_DIVISOR } from './platform/module-budget';
import type { BudgetLimits, ModuleManifest } from './platform/module-kit/manifest';
import { DEADLINE_MS_MAX, JOB_DEADLINE_MS_MAX } from './platform/module-kit/registry';
import { OUTBOX_ATTEMPTS_MAX } from './platform/outbox-drain';
import { OUTBOX_STALE_AFTER_SECONDS } from './platform/outbox-report';
import { OUTBOX_DEAD_KEPT_DAYS } from './platform/outbox-sweep';
import { DEFAULT_DEADLINE_MS } from './platform/request-deadline';
import { SOCKET_FRAME_BUDGET } from './realtime/rate-limiter';
import {
  NOTICE_PUSH_BUDGET,
  PUSH_ATTEMPTS_MAX,
  PUSH_LEASE_MS,
  PUSH_PENDING_PER_PERSON,
  PUSH_POSTS_AT_ONCE,
  PUSH_POSTS_PER_PERSON,
  PUSH_TTL_SECONDS,
} from './platform/push-policy';

/** As prose: a line break in Markdown is a space, and rewrapping a paragraph changes nothing. */
const prose = (path: string): string => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const api = prose('docs/API.md');
const architecture = prose('docs/ARCHITECTURE.md');
const modules = prose('docs/MODULES.md');

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
];

const numberWord = (value: number): string => {
  const word = NUMBER_WORDS[value];
  if (word === undefined) throw new Error(`No prose number for ${String(value)}`);
  return word;
};

/** The numeric cap a source file declares; executable test helpers cannot be imported to read it. */
const capIn = (file: string, name: string): number => {
  const found = new RegExp(`const ${name} = (\\d[\\d_]*);`).exec(readFileSync(file, 'utf8'));
  if (found?.[1] === undefined) throw new Error(`${file} has no \`const ${name} = <number>;\``);
  return Number(found[1].replaceAll('_', ''));
};

describe('numbers the documents state', () => {
  test('durable push documents state the actual admission, lifetime, retry and maintenance bounds', () => {
    const decision = prose('docs/DECISIONS.md').split('### D-307.')[1]?.toLowerCase() ?? '';
    const configuration = prose('docs/CONFIG.md').toLowerCase();
    const schema = prose('docs/SCHEMA.md').toLowerCase();
    const push = 'apps/api/src/modules/push/';
    expect(decision).toContain(`within ${numberWord(PUSH_TTL_SECONDS / 86_400)} day`);
    expect(decision).toContain(
      `${new Intl.NumberFormat('en-US').format(PUSH_PENDING_PER_PERSON)} occurrences per recipient`,
    );
    expect(decision).toContain(`at most ${String(PUSH_POSTS_AT_ONCE)} handoffs`);
    expect(decision).toContain(`${numberWord(PUSH_POSTS_PER_PERSON)} live claims per recipient`);
    expect(decision).toContain(`${numberWord(PUSH_ATTEMPTS_MAX)} eligible attempts`);
    expect(configuration).toContain(
      `retry up to ${numberWord(PUSH_ATTEMPTS_MAX)} eligible attempts`,
    );
    expect(schema).toContain(
      `${numberWord(PUSH_ATTEMPTS_MAX)} eligible attempts; ${String(PUSH_LEASE_MS / 1_000)}-second claim`,
    );
    expect(decision).toContain(`a ${String(PUSH_LEASE_MS / 1_000)}-second lease`);
    expect(decision).toContain(
      `(${numberWord(NOTICE_PUSH_BUDGET.burst)} at once, then ${numberWord(NOTICE_PUSH_BUDGET.perSecond * 60)} a minute)`,
    );
    expect(decision).toContain(
      `a ${numberWord(capIn(push + 'sender.ts', 'POLL_MS') / 1_000)}-second poll`,
    );
    expect(configuration).toContain(
      `for ${numberWord(capIn(push + 'sender.ts', 'FLUSH_BOUND_MS') / 1_000)} seconds`,
    );
    expect(decision).toContain(
      `indexed batches of ${String(capIn(push + 'maintenance.ts', 'SWEEP_BATCH_MAX'))}`,
    );
    expect(decision).toContain(
      `at most ${numberWord(capIn(push + 'sender.ts', 'MAX_MAINTENANCE_PASSES'))} passes`,
    );
    expect(decision).toContain(
      `exponential ${String(capIn(push + 'queue-result.ts', 'BACKOFF_BASE_MS') / 1_000)}-second-to-${String(capIn(push + 'queue-result.ts', 'BACKOFF_MAX_MS') / 60_000)}-minute backoff`,
    );
  });
  test('API.md states the page cap and default the contract enforces', () => {
    expect(api).toContain(
      `capped at ${String(PAGE_LIMIT.max)} (default ${String(PAGE_LIMIT.default)})`,
    );
  });

  test('ARCHITECTURE.md §5.5 states the frame cap the contract enforces', () => {
    expect(architecture).toContain(`Max frame size ${String(MAX_FRAME_BYTES / 1024)} KB`);
  });

  test('ARCHITECTURE.md §5.5 states the rate budget the limiter enforces', () => {
    expect(architecture).toContain(
      `${String(SOCKET_FRAME_BUDGET.perSecond)} frames/second with a burst of ${String(SOCKET_FRAME_BUDGET.burst)}`,
    );
  });

  test('MODULES.md states the starvation factor of the latency gate', () => {
    expect(modules).toContain(
      `more than ${NUMBER_WORDS[STARVATION_FACTOR] ?? '?'} times** that (\`STARVATION_FACTOR\``,
    );
  });

  test('MODULES.md §9 states the caps of the lists that only shrink, as the tests hold them', () => {
    const unindexed = capIn('packages/db/src/query-columns.integration.test.ts', 'MAX_UNINDEXED');
    expect(modules).toContain(
      `${NUMBER_WORDS[unindexed] ?? '?'} reasoned exceptions, capped at ${String(unindexed)}`,
    );
    const grandfathered = capIn('packages/db/src/migration-safety.test.ts', 'MAX_GRANDFATHERED');
    expect(modules).toContain(
      `${NUMBER_WORDS[grandfathered] ?? '?'} shipped files grandfathered with a reason, capped at ${String(grandfathered)}`,
    );
    const unseeded = capIn('apps/api/src/table-lifecycle.integration.test.ts', 'MAX_UNSEEDED_KEPT');
    const anonymised = Object.values(TABLE_LIFECYCLE).filter(
      ({ erasure }) => erasure === 'anonymised',
    ).length;
    expect(modules).toContain(
      `(all ${String(anonymised)}; the allow-list of unprobed tables is empty and capped at ${String(unseeded)})`,
    );
  });

  test('MODULES.md names the files the core may still name a table in, and the cap holds exactly them', () => {
    const source = readFileSync('apps/api/src/core-tables.test.ts', 'utf8');
    const block = /const ALLOWED[^=]*= \{([^]*?)\n\};/.exec(source)?.[1] ?? '';
    const allowed = [...block.matchAll(/^ {2}'([^']+)':/gm)].map((match) => match[1] ?? '');
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.length).toBe(capIn('apps/api/src/core-tables.test.ts', 'MAX_ALLOWED'));
    for (const file of allowed) {
      expect({ file, named: modules.includes(`\`${file}\``) }).toEqual({ file, named: true });
    }
    const listed = [...modules.matchAll(/`(cli\/[\w-]+\.ts)`/g)].map((match) => match[1] ?? '');
    const namedAsDemo = listed.filter((file) => /demo|budget-latency/.test(file));
    expect(new Set(namedAsDemo)).toEqual(new Set(allowed));
  });

  test('MODULES.md §4 states how many writes of a core table chat has left', () => {
    const writes = capIn('apps/api/src/module-tables.test.ts', 'MAX_CORE_WRITES');
    expect(modules).toContain(
      `${NUMBER_WORDS[writes] ?? '?'} writes of a core table (\`CORE_WRITES\` in`,
    );
  });
});

const WORD_VALUES: Readonly<Record<string, number>> = {
  ...Object.fromEntries(NUMBER_WORDS.map((word, value) => [word, value])),
  twenty: 20,
  thirty: 30,
  third: 3,
  fifth: 5,
};

/** A number as a document writes it: `8`, `3 600 000`, `64`, or a word (`eight`, `thirty`, `third`). */
const valueOf = (written: string): number =>
  WORD_VALUES[written.toLowerCase()] ?? Number(written.replace(/[ ,]/g, ''));

const seconds = (ms: number): number => ms / 1000;
const manifests: readonly ModuleManifest[] = bundledModules.map(({ manifest }) => manifest);
const manifestOf = (id: string): ModuleManifest => {
  const found = manifests.find((manifest) => manifest.id === id);
  if (found === undefined) throw new Error(`no module ${id}`);
  return found;
};
const issuesDeadline = manifestOf('issues').deadline;
const issuesDeadlineMs =
  issuesDeadline !== undefined && 'ms' in issuesDeadline ? issuesDeadline.ms : -1;
const poolOfTen = (id: string): BudgetLimits => {
  const { budget } = manifestOf(id);
  if ('none' in budget) throw new Error(`${id} has no pool share`);
  return budget.poolShare(10);
};

interface Claim {
  readonly doc: 'api' | 'architecture' | 'modules' | 'config' | 'deploy' | 'contributing';
  /** One capture group for each number of `expected`, in order. */
  readonly pattern: RegExp;
  readonly expected: readonly number[];
  readonly what: string;
}

const deploy = prose('docs/DEPLOY.md');
const config = prose('docs/CONFIG.md').replace(/ > /g, ' ');
const texts = {
  api,
  architecture,
  modules,
  config,
  deploy,
  contributing: prose('CONTRIBUTING.md'),
};

/**
 * Every sentence of a document that states a number about the module platform, with the constant that owns it. A claim
 * fails when the document says another number, and when no sentence matches any more (the sentence moved or was reworded:
 * move the claim with it, so the number stays held). A table is better than a sentence: `docs-sync.ts` writes those.
 */
const CLAIMS: readonly Claim[] = [
  {
    doc: 'api',
    pattern: /\((\d+) s by default, (\d+) s for issues\)/,
    expected: [seconds(DEFAULT_DEADLINE_MS), seconds(issuesDeadlineMs)],
    what: 'API.md 504: the default deadline and the issues deadline',
  },
  {
    doc: 'modules',
    pattern: /`deadline` in the manifest: (\d+) s by default, (\d+) s for issues/,
    expected: [seconds(DEFAULT_DEADLINE_MS), seconds(issuesDeadlineMs)],
    what: 'MODULES.md §7: the default deadline and the issues deadline',
  },
  {
    doc: 'modules',
    pattern: /left out, (\d+) s \(§7\)/,
    expected: [seconds(DEFAULT_DEADLINE_MS)],
    what: 'MODULES.md §2: the default deadline',
  },
  {
    doc: 'modules',
    pattern: /answered `504 REQUEST_TIMEOUT` after (\d+) s/,
    expected: [seconds(DEFAULT_DEADLINE_MS)],
    what: 'MODULES.md §9: the default deadline',
  },
  {
    doc: 'modules',
    pattern: /a whole number from (\d+) to (\d+)\) or `\{ none/,
    expected: [1000, DEADLINE_MS_MAX],
    what: 'MODULES.md §2: the range of a request deadline',
  },
  {
    doc: 'modules',
    pattern: /refuses a deadline under a second, over (\w+) minutes/,
    expected: [DEADLINE_MS_MAX / 60_000],
    what: 'MODULES.md §9: the longest request deadline, in minutes',
  },
  {
    doc: 'modules',
    pattern: /`jobDeadline` in the manifest \(`\{ ms \}` from (\d+) to (\d[\d ]*\d),/,
    expected: [1000, JOB_DEADLINE_MS_MAX],
    what: 'MODULES.md §7: the range of a job deadline',
  },
  {
    doc: 'modules',
    pattern: /(\w+) minutes when left out, `DEFAULT_JOB_DEADLINE_MS`/,
    expected: [DEFAULT_JOB_DEADLINE_MS / 60_000],
    what: 'MODULES.md §7: the default job deadline, in minutes',
  },
  {
    doc: 'modules',
    pattern: /`features\/issues\/budget.ts`\): a (\w+) of `DATABASE_POOL_MAX`/,
    expected: [POOL_SHARE_DIVISOR],
    what: 'MODULES.md §7: issues take 1/n of the pool',
  },
  {
    doc: 'modules',
    pattern: /a queue timeout of (\w+) second and a statement limit of (\w+)\./,
    expected: [ISSUES_QUEUE_TIMEOUT_MS / 1000, ISSUES_STATEMENT_TIMEOUT_MS / 1000],
    what: 'MODULES.md §7: issues queue timeout and statement limit, in seconds',
  },
  {
    doc: 'modules',
    pattern: /`coreReserve`: a (\w+), at least one/,
    expected: [CORE_RESERVE_DIVISOR],
    what: 'MODULES.md §7: the core keeps 1/n of the pool',
  },
  {
    doc: 'modules',
    pattern: /(\w+) of a pool of (\w+), a queue\s+timeout of (\w+) seconds/,
    expected: [poolOfTen('chat').maxConcurrent, 10, poolOfTen('chat').queueTimeoutMs / 1000],
    what: 'MODULES.md §7: chat share of a pool of ten and its queue timeout',
  },
  {
    doc: 'modules',
    pattern:
      /names each as `table.column` with the module and why, and the core's files that may name it \(the route that sets it, the erasure that clears it, the export that lists it\)\. (\w+) today/,
    expected: [Object.keys(CORE_COLUMNS_FOR_A_MODULE).length],
    what: 'MODULES.md §5: how many core columns exist for a module',
  },
  {
    doc: 'config',
    pattern: /takes at most a (\w+) of it/,
    expected: [POOL_SHARE_DIVISOR],
    what: 'CONFIG.md DATABASE_POOL_MAX: issues take 1/n of the pool',
  },
  {
    doc: 'config',
    pattern:
      /Sign-in: (\d+) requests per client address at once, then one every (\w+) seconds\. Writes: (\d+) a second with a burst of (\d+)/,
    expected: [
      AUTH_BUDGET.burst,
      1 / AUTH_BUDGET.perSecond,
      WRITE_BUDGET.perSecond,
      WRITE_BUDGET.burst,
    ],
    what: 'CONFIG.md: the HTTP rate limits',
  },
  {
    doc: 'config',
    pattern: /The largest JSON body is (\d+) KiB/,
    expected: [JSON_BODY_MAX_BYTES / 1024],
    what: 'CONFIG.md: the largest JSON body',
  },
  {
    doc: 'api',
    pattern: /a JSON body over (\d+) KiB \(`JSON_BODY_MAX_BYTES`/,
    expected: [JSON_BODY_MAX_BYTES / 1024],
    what: 'API.md 413: the largest JSON body',
  },
  {
    doc: 'deploy',
    pattern: /\(`outbox:consume`, every (\w+) seconds,/,
    expected: [OUTBOX_CONSUME_INTERVAL_MS / 1000],
    what: 'DEPLOY.md: the outbox worker interval',
  },
  {
    doc: 'deploy',
    pattern: /given up on after (\w+) tries, kept (\w+) days\)/,
    expected: [OUTBOX_ATTEMPTS_MAX, OUTBOX_DEAD_KEPT_DAYS],
    what: 'DEPLOY.md: the outbox attempts and how long dead rows are kept',
  },
  {
    doc: 'deploy',
    pattern: /One workspace may have `OUTBOX_PENDING_MAX` \((\d+)\) facts waiting/,
    expected: [OUTBOX_PENDING_MAX_DEFAULT],
    what: 'DEPLOY.md: the backlog ceiling of a workspace for one module',
  },
  {
    doc: 'deploy',
    pattern: /a fact that has waited more than (\d+) minutes/,
    expected: [OUTBOX_STALE_AFTER_SECONDS / 60],
    what: 'DEPLOY.md: when the overview calls a fact stale',
  },
];

describe('numbers the documents state about the module platform', () => {
  test.each(CLAIMS.map((claim) => [claim.what, claim] as const))('%s', (_what, claim) => {
    const found = [...texts[claim.doc].matchAll(new RegExp(claim.pattern, 'g'))];
    expect({ sentences: found.length > 0, pattern: String(claim.pattern) }).toEqual({
      sentences: true,
      pattern: String(claim.pattern),
    });
    for (const match of found) {
      expect(match.slice(1).map(valueOf), `${claim.what}: the document says ${match[0]}`).toEqual(
        claim.expected as number[],
      );
    }
  });
});
