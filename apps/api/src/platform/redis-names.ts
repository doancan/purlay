/**
 * Every name Purlay gives in a shared Redis — its keys and its pub/sub channel — built here and nowhere else
 * (D-201).
 *
 * Two deployments that share one Redis (staging beside production, two clusters of two tenants) would hear
 * each other's bus frames and share each other's presence, typing records and rate-limit buckets if their
 * names were the same. `REDIS_KEY_PREFIX` gives each its own **namespace**, and this is where it is applied:
 * `purlay` by default, which is the name every deployment has always had, so nothing already running moves.
 * The colon after the namespace is added here, which is why a namespace cannot hold one: `a:b` would be a
 * namespace that starts with another's.
 *
 * `redis-names.test.ts` holds that no other file of the API writes a `purlay:` name into Redis.
 */

export const DEFAULT_REDIS_NAMESPACE = 'purlay';

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, 1 to 32 long. No `:`, no `{}` (cluster slots), no space. */
export const REDIS_NAMESPACE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$';
const NAMESPACE = new RegExp(REDIS_NAMESPACE_PATTERN);

export interface RedisNames {
  /** The one pub/sub channel the whole cluster publishes on. */
  readonly bus: string;
  /** The hash of the modules each node runs. */
  readonly moduleSet: string;
  /** The hash of the nodes that read a workspace's grants (D-292). */
  readonly entitlementNodes: string;
  /** The hash of the nodes that read the modules the administrator has stopped (D-296). */
  readonly suspensionNodes: string;
  /** The hash of API nodes that enforce workspace authentication and session policy (D-310). */
  readonly workspaceAccessNodes: string;
  /** Typing windows: this, then `channelId:userId`. */
  readonly typingPrefix: string;
  /** A person's online record: this, then `userId`. */
  readonly onlinePrefix: string;
  /** When each person's record lapses, and when their quiet time comes: sorted sets. */
  readonly lapseIndex: string;
  readonly idleIndex: string;
  /** One bucket per limiter name and key: this, then `name:key`. */
  readonly bucketPrefix: string;
}

/** The names of one namespace. Refuses a namespace `REDIS_KEY_PREFIX` would have refused. */
export const redisNames = (namespace: string = DEFAULT_REDIS_NAMESPACE): RedisNames => {
  if (!NAMESPACE.test(namespace)) {
    throw new RangeError(`not a Redis namespace: it must match ${REDIS_NAMESPACE_PATTERN}`);
  }
  const prefix = `${namespace}:`;
  return {
    bus: `${prefix}bus`,
    moduleSet: `${prefix}modules`,
    entitlementNodes: `${prefix}entitlement-nodes`,
    suspensionNodes: `${prefix}suspension-nodes`,
    workspaceAccessNodes: `${prefix}workspace-access-nodes`,
    typingPrefix: `${prefix}typing:`,
    onlinePrefix: `${prefix}online:`,
    lapseIndex: `${prefix}online-lapse`,
    idleIndex: `${prefix}online-idle`,
    bucketPrefix: `${prefix}rl:`,
  };
};
