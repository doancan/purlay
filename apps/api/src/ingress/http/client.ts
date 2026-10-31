/**
 * The built client, served from the one origin (D-61).
 *
 * The browser talks to exactly one origin, so in production the API answers for the
 * client's files as well as for itself. What is here decides, for a path, whose it is
 * and which file it means; `app.ts` turns that into a response through the same hooks
 * and the same error handler as every other route.
 *
 * The demo's front server sends everything but its login to the API, so the browser tests
 * exercise this file rather than a copy of it.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { ConfigurationError } from '../../platform/config';

/** The paths the API owns. Anything else is the client's. */
const API_PREFIXES = ['/auth', '/api', '/health', '/metrics'] as const;

export type Route = 'socket' | 'api' | 'client';

export const routeOf = (pathname: string): Route => {
  if (pathname === '/ws') return 'socket';
  if (
    [...API_PREFIXES, '/ws'].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return 'api';
  }
  return 'client';
};

/** The path as a name, or null when its percent-encoding is malformed. */
const decoded = (pathname: string): string | null => {
  try {
    return decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
};

/** The file a path means inside `dist`, or null when it would climb out or cannot be a name. */
export const fileFor = (dist: string, pathname: string): string | null => {
  const name = decoded(pathname);
  if (name === null) return null;
  // A NUL ends the name at the system call, so `x.js%00.html` would be read as `x.js` after
  // being judged as `.html`.
  if (name.includes('\0')) return null;
  const candidate = normalize(join(dist, name));
  return candidate === dist || candidate.startsWith(dist + sep) ? candidate : null;
};

/** A built client that has been looked at: its directory holds a shell. */
export interface Client {
  readonly dist: string;
}

/**
 * Opens the build, or refuses to start. A directory without `index.html` would be an
 * instance that is healthy, ready and answers every page with a 404 — the kind of failure
 * nobody notices until a person does.
 */
export const openClient = (dist: string): Client => {
  if (!isAbsolute(dist)) {
    throw new ConfigurationError([`CLIENT_DIST: must be an absolute path (${dist})`]);
  }
  // Without a trailing separator, or every path would be judged outside `dist/`.
  const root = resolve(dist);
  const shell = join(root, 'index.html');
  try {
    if (!statSync(shell).isFile())
      throw new ConfigurationError([`CLIENT_DIST: ${shell} is not a file`]);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    // Named for what it is: an unreadable build is not a missing one.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    throw new ConfigurationError([
      code === 'ENOENT'
        ? `CLIENT_DIST: no index.html in ${root}; build the client`
        : `CLIENT_DIST: ${shell} cannot be read (${code})`,
    ]);
  }
  return { dist: root };
};

/**
 * Whether a request's `If-None-Match` names this version: one of a list, or `*` (RFC 9110
 * §13.1.2, weak comparison).
 */
export const isUnchanged = (ifNoneMatch: string | null, etag: string): boolean =>
  ifNoneMatch
    ?.split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, '')) ?? false;

export interface ClientFile {
  readonly path: string;
  /** An HTML document: it carries the document's security policy (D-102). */
  readonly document: boolean;
  readonly cacheControl: string;
  /**
   * The file's version, from its size and modification time. The runtime sends neither an
   * entity tag nor a modification date for a file, so without this every `no-cache` file —
   * the shell, the fonts — would be downloaded whole on every load. A file in an image keeps
   * its time for as long as the image does, so the tag changes with a deployment and not
   * with a restart.
   */
  readonly etag: string;
}

const answer = (path: string, document: boolean, cacheControl: string): ClientFile => {
  const { size, mtimeMs } = statSync(path);
  return {
    path,
    document,
    cacheControl,
    etag: `W/"${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}"`,
  };
};

/** A file with a hash in its name never changes; everything else is asked about every time. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

const isAssetPath = (pathname: string): boolean =>
  pathname === '/assets' || pathname.startsWith('/assets/');

/**
 * The file that answers a client path, or nothing. A file that is there is served; a path
 * that looks like a file (an extension) or lies in the asset directory and is not there is
 * nothing, so a stale chunk is a 404 rather than a page of HTML parsed as JavaScript; any
 * other path is a client route, and the shell decides what it means.
 */
export const clientFileFor = (client: Client, pathname: string): ClientFile | undefined => {
  // Judged as the name it means: `/%61pi/me` is the API's path, spelled differently.
  const name = decoded(pathname);
  if (name === null || routeOf(name) !== 'client') return undefined;
  const path = fileFor(client.dist, pathname);
  if (path === null) return undefined;
  if (existsSync(path) && statSync(path).isFile()) {
    return answer(path, path.endsWith('.html'), isAssetPath(pathname) ? IMMUTABLE : REVALIDATE);
  }
  if (isAssetPath(pathname) || /\.[A-Za-z0-9]+$/.test(pathname)) return undefined;
  return answer(join(client.dist, 'index.html'), true, REVALIDATE);
};
