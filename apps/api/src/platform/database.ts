/**
 * How to reach the database, from the configuration: the same place and the same TLS for the API's
 * pool, the connection a migration on start opens for itself (D-87), and a scheduled job (D-30).
 */
import { readCaFile, type DatabaseOptions } from '@purlay/db';
import type { Config } from './config';
import type { Logger } from './logging';

export const databaseConnection = (
  config: Config,
  log: Logger,
): DatabaseOptions & { readonly ssl: boolean } => ({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL,
  ...(config.DATABASE_SSL_CA_FILE === undefined
    ? {}
    : { sslCa: readCaFile(config.DATABASE_SSL_CA_FILE) }),
  // Reported and carried on: the pool replaces the dead connection by itself.
  onPoolError: (error: Error): void => {
    log.error('database pool error', { error });
  },
});
