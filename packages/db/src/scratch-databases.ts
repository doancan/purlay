/** Names of owned test databases: PostgreSQL truncates identifiers, including quoted ones (#1202). */
import { createHash } from 'node:crypto';

const IDENTIFIER_BYTES = 63;

/** Preserve short names; retain the whole long name's identity rather than discarding its unique suffix. */
export const scratchDatabaseName = (name: string): string => {
  if (Buffer.byteLength(name) <= IDENTIFIER_BYTES) return name;
  const suffix = `_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const room = IDENTIFIER_BYTES - Buffer.byteLength(suffix);
  let prefix = '';
  let bytes = 0;
  for (const character of name) {
    const size = Buffer.byteLength(character);
    if (bytes + size > room) break;
    prefix += character;
    bytes += size;
  }
  return prefix + suffix;
};

/** The throwaway CLI keeps its ASCII-only clone guard; other source alphabets get an opaque identity. */
export const cloneDatabaseName = (database: string, nonce: string): string => {
  const logical = `${database}_${nonce}`;
  return /^[a-z0-9_]+$/.test(database)
    ? scratchDatabaseName(logical)
    : `purlay_${createHash('sha256').update(logical).digest('hex').slice(0, 12)}`;
};

/** A URL's decoded database name, before appending a test's own suffix. */
export const databaseNameFromUrl = (source: string): string =>
  decodeURIComponent(new URL(source).pathname.slice(1));

/** The same server and options, targeting exactly this name, including literal percent signs or slashes. */
export const onDatabase = (source: string, name: string): string => {
  const url = new URL(source);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
};

/** Shared with the matrix's cleanup: a long parent's template is not a literal concatenation. */
export const integrationTemplateName = (database: string): string =>
  scratchDatabaseName(`${database}_template`);
