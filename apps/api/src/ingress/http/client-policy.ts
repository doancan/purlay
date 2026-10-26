/**
 * Which native client versions this server still serves, and the reading of the header a client
 * says them with.
 *
 * A browser client ships with the server, so it can never be too old. An installed application is
 * updated on its own schedule and will meet servers newer than itself; the one thing the server may
 * do about an app that can no longer work is refuse it with a word the app can act on (`426`, with
 * where to get a newer one). Everything else about reading the header is leniency, because a refusal
 * that fires on a typo locks a person out of their own server: a header that is not exactly the
 * shape — and a browser sends none — is no client at all, and is let through.
 */

/** What `X-Purlay-Client` says: `macos/<semver> contract/<n>`. */
export interface ClientIdentity {
  readonly platform: string;
  readonly version: string;
  readonly contract: number;
}

/** What the operator decided about one platform. `null` is no limit. */
interface PlatformPolicy {
  /** The lowest wire contract the server still serves (`CONTRACT_VERSION` in `@purlay/types`). */
  readonly contract: number | null;
  /** The lowest application version, in semantic-version order. */
  readonly version: string | null;
  /** Where a person gets a newer one, shown by the application. */
  readonly downloadUrl: string | null;
}

export interface ClientPolicy {
  readonly macos: PlatformPolicy;
}

/** What a refused client is told. */
export interface ClientRefusal {
  readonly minContract: number | null;
  readonly minVersion: string | null;
  readonly downloadUrl: string | null;
}

// Strict on purpose: lower-case platform, one space, a plain semantic version, a contract of at most
// six digits. `$` without the multiline flag ends the input, so a trailing newline is not the shape.
// A pre-release is dot-separated identifiers, none of them empty (`1.0.0-..` is not one), in at most 32 characters.
const HEADER =
  /^([a-z][a-z0-9-]{0,15})\/(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?=[0-9A-Za-z.-]{1,32} contract)[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?) contract\/(\d{1,6})$/;

export const parseClientHeader = (value: string | null): ClientIdentity | null => {
  if (value === null) return null;
  const match = HEADER.exec(value);
  if (match === null) return null;
  const [, platform, version, contract] = match;
  if (platform === undefined || version === undefined || contract === undefined) return null;
  return { platform, version, contract: Number(contract) };
};

const identifiersOf = (version: string): { core: number[]; pre: string[] } => {
  // Only the first hyphen separates the pre-release from the core; a hyphen after it is the pre-release's own.
  const dash = version.indexOf('-');
  const core = dash === -1 ? version : version.slice(0, dash);
  const pre = dash === -1 ? undefined : version.slice(dash + 1);
  return {
    core: core.split('.').map(Number),
    pre: pre === undefined ? [] : pre.split('.'),
  };
};

const NUMERIC = /^\d+$/;

/**
 * Semantic-version order, which is the one the operator writes a minimum in: a pre-release is before
 * the release it leads to, numeric pre-release identifiers compare as numbers and sort before the
 * alphanumeric ones. Negative, zero or positive, as `a` is before, equal to or after `b`.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = identifiersOf(a);
  const right = identifiersOf(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const shared = Math.min(left.pre.length, right.pre.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left.pre[index] ?? '';
    const y = right.pre[index] ?? '';
    if (x === y) continue;
    const xNumber = NUMERIC.test(x);
    const yNumber = NUMERIC.test(y);
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
};

/**
 * Whether this client may no longer be served, and what to tell it. `null` lets it through: no
 * header, a header that is not the shape, a platform nobody set a limit for, or a client at or above
 * every limit that is set.
 */
export const clientRefusal = (
  header: string | null,
  policy: ClientPolicy,
): ClientRefusal | null => {
  const client = parseClientHeader(header);
  if (client?.platform !== 'macos') return null;
  const { contract, version, downloadUrl } = policy.macos;
  const tooOldByContract = contract !== null && client.contract < contract;
  const tooOldByVersion = version !== null && compareVersions(client.version, version) < 0;
  if (!tooOldByContract && !tooOldByVersion) return null;
  return { minContract: contract, minVersion: version, downloadUrl };
};

/**
 * The roads a client too old is still let down: liveness, and `GET /api/client` — the one it learns to
 * update by. Matched as the router matches, which is not strictly: repeated slashes are one and a
 * trailing one is dropped, so `/api/client/` reaches the same handler and must be exempt too. A path
 * that merely begins with one of them is not it.
 */
const OUTSIDE_POLICY: ReadonlySet<string> = new Set(['/api/client', '/health', '/health/ready']);

export const isOutsideClientPolicy = (pathname: string): boolean => {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const path = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return OUTSIDE_POLICY.has(path);
};
