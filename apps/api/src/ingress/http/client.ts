/**
 * The built client, served from the one origin (D-61).
 *
 * The browser talks to exactly one origin, so in production the API answers for the
 * client's files as well as for itself. What is here decides, for a path, whose it is
 * and which file it means; `app.ts` turns that into a response through the same hooks
 * and the same error handler as every other route.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { ConfigurationError } from '../../platform/config';

/** The paths the API owns. Anything else is the client's. */
const API_PREFIXES = ['/auth', '/api', '/health'] as const;

export type Route = 'socket' | 'api' | 'client';

export const routeOf = (pathname: string): Route => {
  if (pathname === '/ws') return 'socket';
  if (API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'api';
  }
  return 'client';
};

/** The file a path means inside `dist`, or null when it would climb out or cannot be a name. */
export const fileFor = (dist: string, pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // A NUL ends the name at the system call, so `x.js%00.html` would be read as `x.js` after
  // being judged as `.html`.
  if (decoded.includes('\0')) return null;
  const candidate = normalize(join(dist, decoded));
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
  const shell = join(dist, 'index.html');
  if (!existsSync(shell) || !statSync(shell).isFile()) {
    throw new ConfigurationError([`CLIENT_DIST: no index.html in ${dist}; build the client`]);
  }
  return { dist: normalize(dist) };
};

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
const IMMUTABLE = 'public, max-age=31536000, immutable';
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
  const path = fileFor(client.dist, pathname);
  if (path === null) return undefined;
  if (existsSync(path) && statSync(path).isFile()) {
    return answer(path, path.endsWith('.html'), isAssetPath(pathname) ? IMMUTABLE : REVALIDATE);
  }
  if (isAssetPath(pathname) || /\.[A-Za-z0-9]+$/.test(pathname)) return undefined;
  return answer(join(client.dist, 'index.html'), true, REVALIDATE);
};
