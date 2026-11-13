/** The exact native workspace cohort, alone in a fresh process for every case and eligible module cell. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import {
  createDatabase,
  databaseNameFromUrl,
  dropDatabases,
  integrationTemplateName,
  onDatabase,
  scratchDatabaseName,
  sql,
} from '@purlay/db';
import { BUDGETS } from '../cli/budget-latency';
import { bundledModules } from '../composition';
import { moduleCells, type ModuleCell } from './module-cells';
import { needsReader } from './module-needs';

const REPOSITORY = resolve(import.meta.dir, '../../../..');
const SUITE = 'apps/api/src/realtime/workspace-delivery-batch.integration.test.ts';
const OUTPUT = resolve(REPOSITORY, '.budget/workspace-cohort');

/** Direct tests remain strict. Only the two general suite runners explicitly delegate the clock to this command. */
export const cohortMode = (
  environment: Readonly<Record<string, string | undefined>>,
): 'strict' | 'functional' | 'measure' => {
  const mode = environment['PURLAY_WORKSPACE_COHORT'];
  if (mode === undefined) return 'strict';
  if (mode === 'functional' || mode === 'measure') return mode;
  throw new Error('PURLAY_WORKSPACE_COHORT must be functional or measure, or unset for strict');
};

/** A measured fixture writes only the explicit absolute JSON receipt owned by its invoking runner. */
export const cohortReceiptPath = (
  environment: Readonly<Record<string, string | undefined>>,
  ordinaryPath: string,
): string => {
  if (cohortMode(environment) !== 'measure') return ordinaryPath;
  const runId = environment['PURLAY_WORKSPACE_COHORT_RUN'] ?? '';
  const path = environment['PURLAY_WORKSPACE_COHORT_RECEIPT'] ?? '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId) ||
    !isAbsolute(path) ||
    !path.endsWith('.json')
  )
    throw new Error(
      'The measurement requires a fresh UUID and an absolute owned JSON receipt path',
    );
  return path;
};

/** The suite's own declared and imported needs select its cells, including the all-modules cell. */
export const measurementCells = (): readonly ModuleCell[] => {
  const ids = bundledModules.map(({ manifest }) => manifest.id);
  const needs = needsReader(ids)(resolve(REPOSITORY, SUITE));
  if (needs.some((id) => !ids.includes(id))) throw new Error('The cohort needs an unknown module');
  const cells = moduleCells(bundledModules).filter((cell) =>
    needs.every((id) => cell.ids.includes(id)),
  );
  if (cells.length === 0) throw new Error('No module cell can run the workspace cohort');
  return cells;
};

interface Identity {
  readonly runId: string;
  readonly company: boolean;
  readonly modules: string;
}

/** A successful process alone is insufficient: a missing, partial or earlier receipt is a failure. */
export const receiptP95 = (value: unknown, identity: Identity): number => {
  const record = (candidate: unknown): Record<string, unknown> => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
      throw new Error('The cohort receipt is not complete');
    return candidate as Record<string, unknown>;
  };
  const receipt = record(value);
  const measurement = record(receipt['measurement']);
  const fanout = record(receipt['fanout']);
  const sources = receipt['nativeSources'];
  const reads = receipt['factualSelects'];
  const p95 = fanout['receiptP95Ms'];
  if (
    measurement['mode'] !== 'measure' ||
    measurement['runId'] !== identity.runId ||
    measurement['company'] !== identity.company ||
    measurement['modules'] !== identity.modules
  )
    throw new Error('The cohort receipt is stale or belongs to another case');
  if (
    !Array.isArray(sources) ||
    sources.length !== 2 ||
    sources[0] !== 12 ||
    sources[1] !== 120 ||
    !Array.isArray(reads) ||
    reads.length !== 2 ||
    !Number.isInteger(reads[0]) ||
    reads[0] <= 0 ||
    reads[0] > 8 ||
    reads[1] !== reads[0] * 2 ||
    fanout['sources'] !== 120 ||
    fanout['sent'] !== 120 ||
    fanout['receipts'] !== 120 ||
    receipt['productFanoutBudgetMs'] !== BUDGETS.fanOutMs ||
    receipt['complete'] !== true
  )
    throw new Error('The cohort receipt is missing deliveries or bounded native reads');
  if (typeof p95 !== 'number' || !Number.isFinite(p95) || p95 <= 0 || p95 >= BUDGETS.fanOutMs)
    throw new Error(
      `The cohort p95 must be below ${String(BUDGETS.fanOutMs)} ms; received ${String(p95)}`,
    );
  return p95;
};

type RunCase = (
  cell: ModuleCell,
  identity: Identity,
  receipt: string,
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<number>;

const runCase: RunCase = async (cell, identity, receipt, environment) => {
  const base = environment['DATABASE_URL'] ?? '';
  const database = scratchDatabaseName(
    `${databaseNameFromUrl(base)}_cohort_${identity.runId.replaceAll('-', '')}`,
  );
  const admin = createDatabase({ connectionString: onDatabase(base, 'postgres'), poolSize: 1 });
  try {
    await sql`create database ${sql.id(database)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  const inherited = { ...environment };
  delete inherited['MODULES'];
  try {
    return await Bun.spawn(
      [
        'bun',
        '--no-env-file',
        'test',
        '--isolate',
        '--test-name-pattern',
        `company=${String(identity.company)}`,
        `./${SUITE}`,
      ],
      {
        cwd: REPOSITORY,
        env: {
          ...inherited,
          DATABASE_URL: onDatabase(base, database),
          ...(cell.setting === undefined ? {} : { MODULES: cell.setting }),
          PURLAY_WORKSPACE_COHORT: 'measure',
          PURLAY_WORKSPACE_COHORT_RUN: identity.runId,
          PURLAY_WORKSPACE_COHORT_RECEIPT: receipt,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    ).exited;
  } finally {
    await dropDatabases([integrationTemplateName(database), database]);
  }
};

/** Every case runs once, sequentially. One failure refuses the entire run; no minimum, retry or baseline can forgive it. */
export const measure = async (
  environment: Readonly<Record<string, string | undefined>>,
  folder: string = resolve(OUTPUT, randomUUID()),
  run: RunCase = runCase,
): Promise<number> => {
  await mkdir(resolve(folder, '..'), { recursive: true });
  await mkdir(folder);
  const results: { modules: string; company: boolean; p95?: number; error?: string }[] = [];
  for (const cell of measurementCells()) {
    for (const company of [false, true]) {
      const modules = cell.setting ?? 'all';
      const identity = { runId: randomUUID(), company, modules };
      const path = resolve(
        folder,
        `${modules.replaceAll(',', '-')}-${company ? 'company' : 'independent'}.json`,
      );
      await rm(path, { force: true });
      try {
        const code = await run(cell, identity, path, environment);
        if (code !== 0) throw new Error(`The cohort process exited ${String(code)}`);
        const p95 = receiptP95(JSON.parse(await readFile(path, 'utf8')) as unknown, identity);
        results.push({ modules, company, p95 });
        process.stdout.write(
          `workspace cohort — ${modules}, company=${String(company)}: p95 ${p95.toFixed(2)} < ${String(BUDGETS.fanOutMs)} ms\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ modules, company, error: message });
        process.stderr.write(
          `workspace cohort — ${modules}, company=${String(company)}: ${message}\n`,
        );
      }
    }
  }
  await writeFile(resolve(folder, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
  return results.some((result) => result.error !== undefined) ? 1 : 0;
};

const reachable = async (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url);
  return await new Promise<boolean>((done) => {
    const socket = createConnection({ host: hostname, port: Number(port || 5432) });
    const finish = (answer: boolean): void => {
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(1_000, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
};

/** As with the other budget commands, absence is explicit locally and a refusal in CI. */
export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  run: typeof measure = measure,
): Promise<{ readonly line: string | null; readonly code: number }> => {
  cohortMode(environment);
  const url = environment['DATABASE_URL'] ?? '';
  if (url === '' || !(await reachable(url))) {
    const reason =
      url === '' ? 'DATABASE_URL is not set' : `nothing answers at ${new URL(url).host}`;
    return environment['CI'] === 'true'
      ? {
          line: `budget:workspace-cohort — ${reason}, and CI provides the database. Refusing to skip a budget.`,
          code: 1,
        }
      : {
          line: `budget:workspace-cohort — ${reason}: the workspace cohort was NOT measured.`,
          code: 0,
        };
  }
  return { line: null, code: await run(environment) };
};

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 2) throw new Error('budget:workspace-cohort accepts no arguments');
    const result = await main(process.env);
    if (result.line !== null)
      (result.code === 0 ? process.stdout : process.stderr).write(`${result.line}\n`);
    process.exit(result.code);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
