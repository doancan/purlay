/**
 * Write the tables of the documents that the code can state, between markers.
 *
 * A number in a document and in the code is two numbers, and only one of them is enforced. A table whose rows are
 * the code's own values is not a copy: this writes it, and `--check` (and `docs-sync.test.ts`) fails when a document
 * is not what the code makes of it. A sentence that names a number is held by `stated-numbers.test.ts` instead.
 *
 *   bun run docs:sync          write the blocks
 *   bun run docs:sync --check  fail if one is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { POOL_DEFAULTS } from '@purlay/db';
import { FACT_HOLD_DAYS_MAX } from '@purlay/types';
import { bundledModules } from '../composition';
import { OUTBOX_PENDING_MAX_DEFAULT } from '../platform/config';
import { DEFAULT_JOB_DEADLINE_MS } from '../modules/jobs/module-shares';
import { DEFAULT_WORKER_DEADLINE_MS } from '../modules/workers/module-workers';
import { OUTBOX_CONSUME_INTERVAL_MS } from '../modules/workers/outbox-consumer';
import type { ModuleManifest } from '../platform/module-kit/manifest';
import { DEADLINE_MS_MAX, JOB_DEADLINE_MS_MAX } from '../platform/module-kit/registry';
import { OUTBOX_ATTEMPTS_MAX, BACKOFF_FIRST_MS, BACKOFF_MAX_MS } from '../platform/outbox-drain';
import { OUTBOX_PAYLOAD_BYTES_MAX } from '../platform/outbox';
import { OUTBOX_STALE_AFTER_SECONDS } from '../platform/outbox-report';
import { OUTBOX_DEAD_KEPT_DAYS } from '../platform/outbox-sweep';
import { DEFAULT_DEADLINE_MS } from '../platform/request-deadline';
import { metricCatalogue } from './metric-catalogue';

/** The pool the shares are shown for: the default a developer reads about, and the size the documents' examples use. */
const EXAMPLE_POOL = 10;
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

const duration = (ms: number): string =>
  ms % MINUTE_MS === 0 ? `${String(ms / MINUTE_MS)} min` : `${String(ms / SECOND_MS)} s`;

const declared = (declaration: ModuleManifest['deadline'], fallbackMs: number): string => {
  if (declaration === undefined) return `${duration(fallbackMs)} (default)`;
  return 'none' in declaration ? 'none' : duration(declaration.ms);
};

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [header, header.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');

const poolShare = (budget: ModuleManifest['budget']): string => {
  if ('none' in budget) return 'none';
  const limits = budget.poolShare(EXAMPLE_POOL);
  return `${String(limits.maxConcurrent)} of ${String(EXAMPLE_POOL)}, queue ${duration(limits.queueTimeoutMs)}, statement ${duration(limits.statementTimeoutMs)}`;
};

const moduleLimits = (): string => {
  const manifests: readonly ModuleManifest[] = bundledModules.map(({ manifest }) => manifest);
  const rows = manifests.map((manifest) => {
    const share = poolShare(manifest.budget);
    return [
      `\`${manifest.id}\``,
      declared(manifest.deadline, DEFAULT_DEADLINE_MS),
      declared(manifest.jobDeadline, DEFAULT_JOB_DEADLINE_MS),
      declared(manifest.workerDeadline, DEFAULT_WORKER_DEADLINE_MS),
      share,
    ];
  });
  return [
    table(
      [
        'Module',
        'Request or frame',
        'Job run',
        'Worker iteration',
        `Pool share (pool of ${String(EXAMPLE_POOL)})`,
      ],
      rows,
    ),
    '',
    `A request deadline is declared from 1 s to ${duration(DEADLINE_MS_MAX)}, a job deadline from 1 s to ${duration(JOB_DEADLINE_MS_MAX)}; the pool's own statement limit is ${duration(POOL_DEFAULTS.statementTimeoutMs)}.`,
  ].join('\n');
};

const outboxPolicy = (): string =>
  table(
    ['Limit', 'Value', 'Constant'],
    [
      ['Tries before a fact is dead', String(OUTBOX_ATTEMPTS_MAX), '`OUTBOX_ATTEMPTS_MAX`'],
      [
        'Wait between tries',
        `from ${duration(BACKOFF_FIRST_MS)}, doubling, to ${duration(BACKOFF_MAX_MS)} (jittered)`,
        '`BACKOFF_FIRST_MS`, `BACKOFF_MAX_MS`',
      ],
      [
        'Consuming worker runs every',
        duration(OUTBOX_CONSUME_INTERVAL_MS),
        '`OUTBOX_CONSUME_INTERVAL_MS`',
      ],
      [
        'Facts one workspace may have waiting for one module',
        String(OUTBOX_PENDING_MAX_DEFAULT),
        '`OUTBOX_PENDING_MAX` (`CONFIG.md`)',
      ],
      ['Dead rows are kept', `${String(OUTBOX_DEAD_KEPT_DAYS)} days`, '`OUTBOX_DEAD_KEPT_DAYS`'],
      [
        'A fact is held for a consumer that is off, at most',
        `${String(FACT_HOLD_DAYS_MAX)} days`,
        '`FACT_HOLD_DAYS_MAX`',
      ],
      [
        'Largest payload (compact JSON)',
        `${String(OUTBOX_PAYLOAD_BYTES_MAX)} bytes`,
        '`OUTBOX_PAYLOAD_BYTES_MAX`',
      ],
      [
        'The overview calls a waiting fact stale after',
        `${String(OUTBOX_STALE_AFTER_SECONDS / 60)} min`,
        '`OUTBOX_STALE_AFTER_SECONDS`',
      ],
    ],
  );

const metricsCatalogue = (): string =>
  table(
    ['Metric', 'Type', 'Labels', 'What it counts'],
    metricCatalogue().map(({ name, type, labels, help }) => [
      `\`${name}\``,
      type,
      labels.length === 0 ? '—' : labels.map((label) => `\`${label}\``).join(', '),
      help.replaceAll('|', '\\|'),
    ]),
  );

export interface GeneratedBlock {
  readonly file: string;
  readonly name: string;
  readonly render: () => string;
}

export const GENERATED_BLOCKS: readonly GeneratedBlock[] = [
  { file: 'docs/MODULES.md', name: 'module-limits', render: moduleLimits },
  { file: 'docs/DEPLOY.md', name: 'outbox-policy', render: outboxPolicy },
  { file: 'docs/DEPLOY.md', name: 'metrics', render: metricsCatalogue },
];

const markers = (name: string): RegExp =>
  new RegExp(`(<!-- generated:${name}\\b[^>]*-->\\n)[^]*?(<!-- /generated:${name} -->)`);

/** The text with the block between its markers made again; a text without the markers is a document that lost them. */
export const withBlock = (text: string, name: string, body: string): string => {
  const pattern = markers(name);
  if (!pattern.test(text)) throw new Error(`no <!-- generated:${name} --> markers`);
  return text.replace(pattern, (_whole, open: string, close: string) => `${open}${body}\n${close}`);
};

/** The files that are not what the code makes of them. */
export const staleFiles = (
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): string[] =>
  [...new Set(GENERATED_BLOCKS.map(({ file }) => file))].filter((file) => {
    const text = read(file);
    return GENERATED_BLOCKS.filter((block) => block.file === file).some(
      ({ name, render }) => withBlock(text, name, render()) !== text,
    );
  });

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale = staleFiles();
  if (check) {
    if (stale.length > 0) {
      process.stderr.write(`${stale.join(', ')} out of date. Run: bun run docs:sync\n`);
      process.exit(1);
    }
    process.stdout.write('generated blocks match the code\n');
  } else {
    for (const file of stale) {
      const text = readFileSync(file, 'utf8');
      writeFileSync(
        file,
        GENERATED_BLOCKS.filter((block) => block.file === file).reduce(
          (current, { name, render }) => withBlock(current, name, render()),
          text,
        ),
      );
      process.stdout.write(`wrote ${file}\n`);
    }
  }
}
