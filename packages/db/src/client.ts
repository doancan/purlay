import { readFileSync } from 'node:fs';
import {
  Kysely,
  PostgresDialect,
  type KyselyPlugin,
  Transaction as KyselyTransaction,
  type PostgresPool,
} from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

/**
 * The Kysely client.
 *
 * `pg` with Kysely's own dialect rather than Bun's built-in SQL: there is no
 * Kysely dialect for it, so using it would mean owning a driver adapter on the
 * hottest path in the system, with no test suite behind it. A driver defect
 * there is a data-correctness defect. (`CONTRIBUTING.md` §1.12)
 *
 * **It fails fast and says what is wrong (D-87).** A pool with every connection
 * busy used to make the next query wait for one to free, for as long as it took —
 * 7.7 s measured with a pool of two. Now the wait is bounded, and running out is
 * a `DatabaseUnavailableError` the API turns into a 503. Every connection also
 * carries a statement timeout, an idle-in-transaction timeout and a name, so a
 * runaway query or a forgotten transaction ends by itself and `pg_stat_activity`
 * says whose it is. The numbers are in `docs/CONFIG.md`.
 */
export interface DatabaseOptions {
  readonly connectionString: string;
  /** `DATABASE_POOL_MAX` — see `docs/CONFIG.md`. */
  readonly poolSize?: number;
  readonly ssl?: boolean;
  /** PEM text of the certificate authority to trust instead of the system's, for a private or managed root. */
  readonly sslCa?: string;
  /** How long a query waits for a free connection before giving up. */
  readonly connectionTimeoutMs?: number;
  /** Server-side limit on one statement; `0` disables it, for the migrator. */
  readonly statementTimeoutMs?: number;
  /** Called when the pool reports a failed idle connection. Without a listener Node would exit. */
  readonly onPoolError?: (error: Error) => void;
}

/** The numbers `docs/CONFIG.md` publishes. */
export const POOL_DEFAULTS = {
  connectionTimeoutMs: 3_000,
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 15_000,
  idleConnectionMs: 30_000,
  applicationName: 'purlay-api',
} as const;

/** No connection could be had: the pool is exhausted, or the server is not answering. */
export class DatabaseUnavailableError extends Error {
  constructor(cause: unknown) {
    super('no database connection was available', { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * The TLS settings as the process environment spells them — what the CLI reads,
 * and what the API's configuration loader (`config.ts`) must agree with, which a
 * test in the API binds. A value neither spelling recognises is refused: a
 * migration run in the clear because of a typo is the quiet failure.
 */
export const tlsFromEnvironment = (
  environment: Record<string, string | undefined>,
): { readonly ssl: boolean; readonly sslCa?: string } => {
  const raw = environment['DATABASE_SSL'];
  let ssl: boolean;
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') ssl = false;
  else if (raw === 'true' || raw === '1') ssl = true;
  else throw new Error(`DATABASE_SSL must be true or false, not "${raw}". See docs/CONFIG.md.`);

  const caFile = environment['DATABASE_SSL_CA_FILE'];
  if (caFile === undefined || caFile === '') return { ssl };
  if (!ssl) throw new Error('DATABASE_SSL_CA_FILE needs DATABASE_SSL=true. See docs/CONFIG.md.');
  return { ssl, sslCa: readCaFile(caFile) };
};

/** Reads the CA a deployment mounted. A path that cannot be read is a boot failure, not a fallback. */
export const readCaFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`DATABASE_SSL_CA_FILE cannot be read: ${path}`, { cause });
  }
};

/** What a caller holds for as long as it holds a connection: a share of the pool, handed back with the connection. */
export interface ConnectionLease {
  /** The session's `statement_timeout` for this connection; the pool's own when absent. */
  readonly statementTimeoutMs?: number;
  /** Called once, when the connection goes back to the pool. */
  readonly release: () => void;
}

/**
 * Asked for each connection a leasing executor takes. It may wait, and refuse by throwing, which reaches the caller of
 * the query as it is. `undefined` is no lease: the connection is taken as the pool gives it.
 */
export type LeaseConnection = () => Promise<ConnectionLease | undefined>;

/** The pool an executor was made on, its connections' statement limit (ms), and the plugins put on it since. */
interface PoolOfExecutor {
  readonly pool: pg.Pool;
  readonly statementTimeoutMs: number;
  readonly plugins: readonly KyselyPlugin[];
}

/** Which pool each executor takes its connections from, so that another can be made on the same one. */
const poolsOfExecutors = new WeakMap<object, PoolOfExecutor>();

/** The `statement_timeout` a connection was last given, where it is not the pool's own. */
const statementTimeouts = new WeakMap<pg.PoolClient, number>();

/** Gives a connection the limit wanted, telling the server only when it differs from what the connection has. */
const alignStatementTimeout = async (
  client: pg.PoolClient,
  wanted: number,
  pool: PoolOfExecutor,
): Promise<void> => {
  const current = statementTimeouts.get(client) ?? pool.statementTimeoutMs;
  if (current === wanted) return;
  await client.query('select set_config($1, $2, false)', ['statement_timeout', String(wanted)]);
  statementTimeouts.set(client, wanted);
};

/**
 * The pool as Kysely takes connections from it. Every failure to obtain one is the same fact to a caller: there was
 * none. With a `lease`, each connection is asked of it first and handed back to it; either way it arrives with the
 * statement limit its holder asked for, since one holder's five seconds are not the next holder's to find.
 */
const connectionsOf = (pool: PoolOfExecutor, lease?: LeaseConnection): PostgresPool => ({
  options: pool.pool.options,
  connect: async (): Promise<pg.PoolClient> => {
    const leased = await lease?.();
    let client: pg.PoolClient;
    try {
      client = await pool.pool.connect();
    } catch (error) {
      leased?.release();
      throw new DatabaseUnavailableError(error);
    }
    try {
      await alignStatementTimeout(
        client,
        leased?.statementTimeoutMs ?? pool.statementTimeoutMs,
        pool,
      );
    } catch (error) {
      // Its state is unknown: the pool discards it.
      client.release(error instanceof Error ? error : new Error(String(error)));
      leased?.release();
      throw error;
    }
    if (leased !== undefined) {
      const giveBack = client.release.bind(client);
      let released = false;
      client.release = (error?: Error | boolean): void => {
        if (!released) {
          released = true;
          leased.release();
        }
        giveBack(error);
      };
    }
    return client;
  },
  end: async (): Promise<void> => {
    await pool.pool.end();
  },
});

/** A Kysely that remembers its pool and plugins, so that `leasingExecutor` can open one like it. */
class PooledKysely<T> extends Kysely<T> {
  private readonly known: PoolOfExecutor;

  constructor(known: PoolOfExecutor) {
    super({ dialect: new PostgresDialect({ pool: connectionsOf(known) }) });
    this.known = known;
    poolsOfExecutors.set(this, known);
  }

  override withPlugin(plugin: KyselyPlugin): Kysely<T> {
    const derived = super.withPlugin(plugin);
    poolsOfExecutors.set(derived, { ...this.known, plugins: [...this.known.plugins, plugin] });
    return derived;
  }
}

/** Opens Kysely on a pool; `statementTimeoutMs` is the pool's own (`0`: none). */
export const executorOnPool = <T = DB>(pool: pg.Pool, statementTimeoutMs = 0): Kysely<T> =>
  new PooledKysely<T>({ pool, statementTimeoutMs, plugins: [] });

/** Lets a test's double (`testing/doubles.ts`) be leased: every connection it is asked for fails with `failure`. */
export const leasableStandIn = (standIn: Executor, failure: Error): Executor => {
  const pool = {
    options: {},
    connect: (): Promise<never> => Promise.reject(failure),
    end: (): Promise<void> => Promise.resolve(),
  } as unknown as pg.Pool;
  poolsOfExecutors.set(standIn, { pool, statementTimeoutMs: 0, plugins: [] });
  return standIn;
};

/**
 * An executor on the pool of `database`, every connection of which is first asked of `lease` (`apps/api`'s module
 * budgets). A transaction is returned as it is: it holds its connection already, and a test's joins the test's.
 */
export const leasingExecutor = (database: Executor, lease: LeaseConnection): Executor => {
  if (isTransaction(database)) return database;
  const known = poolsOfExecutors.get(database);
  if (known === undefined) {
    throw new Error('this executor was not made on a pool this package knows: it cannot be leased');
  }
  const leasing = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: connectionsOf(known, lease) }),
  });
  return known.plugins.reduce((plugged, plugin) => plugged.withPlugin(plugin), leasing);
};

/** What a connection for migrating needs from the process; the limits are not its to choose. */
export type MigrationConnection = Pick<
  DatabaseOptions,
  'connectionString' | 'ssl' | 'sslCa' | 'onPoolError'
>;

/**
 * The connection a migration runs on, whoever starts it: `bun run db:migrate` and a node
 * that migrates as it starts (D-93) both come here, so there is one place that says what a
 * migrating session is.
 *
 * One connection, no statement timeout (D-87): an index build on a table of millions of
 * rows is meant to take as long as it takes, and a migration cut off halfway is the worse
 * outcome. Run on the application's pool it would be cancelled at thirty seconds, and a
 * node that fails to migrate exits and starts again to be cancelled at the same point.
 * The idle-in-transaction limit stays: the runner is never idle inside its transaction.
 */
export const createMigrationDatabase = (connection: MigrationConnection): Executor =>
  createDatabase({
    ...connection,
    poolSize: 1,
    statementTimeoutMs: 0,
    connectionTimeoutMs: 10_000,
  });

export const createDatabase = (options: DatabaseOptions): Executor => {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? POOL_DEFAULTS.connectionTimeoutMs,
    idleTimeoutMillis: POOL_DEFAULTS.idleConnectionMs,
    statement_timeout: options.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs,
    idle_in_transaction_session_timeout: POOL_DEFAULTS.idleInTransactionTimeoutMs,
    application_name: POOL_DEFAULTS.applicationName,
    ...(options.ssl === true
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(options.sslCa === undefined ? {} : { ca: options.sslCa }),
          },
        }
      : {}),
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  return executorOnPool(pool, options.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs);
};

/**
 * Services and repositories take their executor as an argument — a `Kysely` or a
 * `Transaction`, indistinguishable to the caller. That is what makes
 * one-transaction-per-test possible, and it is why no module reaches for a
 * database handle of its own. (D-46)
 */
export type Executor = Kysely<DB>;

/**
 * An executor that is *known* to be inside a transaction. A service that writes
 * twice takes this rather than `Executor`, so passing it the pool — the mistake
 * that leaves half a workspace behind — does not compile. `Executor` accepts a
 * transaction; this does not accept the pool, because the two differ in the
 * literal type of `isTransaction`.
 */
export type Transaction = KyselyTransaction<DB>;

/** Narrows an executor to a transaction, by what it is rather than by a flag. */
export const isTransaction = (executor: Executor): executor is Transaction =>
  executor instanceof KyselyTransaction;
