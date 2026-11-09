/**
 * Which nodes of a cluster read a workspace's grants (D-292), so that a restriction is not written while one that does not is
 * serving. A node that predates the table serves every module to every workspace, so withdrawing a module while it lives would
 * be believed by the operator and ignored by that node.
 *
 * As the module set (`module-set.ts`), a shared hash keeps one field for each node that reads grants, renewed and lapsing by
 * itself; renewal removes expired fields left by crashed nodes, as the module-set record does. `peersBehind` asks how many live
 * nodes of the module-set record have no live field here. No Redis is one node, and one
 * node reads its own table.
 */
import type { Logger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import { systemTimers, type Timers } from './hub';
import { ANNOUNCE_RETRY_MS, FIELD_MAX_CHARS, NODE_TTL_MS } from './module-set';

const RENEW_MS = NODE_TTL_MS / 3;

/**
 * A field that is not a number, or whose lapse lies further ahead than a node ever writes (`now + ttl`), is not a peer and is
 * removed, as in the module-set record (red-team F6): it must not make the script fail, nor count as a node that reads grants.
 */
/** KEYS: the hash of capable nodes. ARGV: node, ttl. */
const ADVERTISE_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local ttl = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], now + ttl)
redis.call('PEXPIRE', KEYS[1], ttl)
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local lapse = tonumber(all[i + 1])
  if (not lapse) or lapse <= now or lapse > now + ttl then redis.call('HDEL', KEYS[1], all[i]) end
end
return 1
`;

/**
 * KEYS: the module-set hash (`node -> lapse|word`), the hash of capable nodes. ARGV: ttl, field cap. Answers how many live nodes are not in the
 * second. A field of the first that is not a live node's (no lapse, a lapse not a number or past `now + ttl`) is not a node; a field
 * of the second that is not a live capable node's does not make one capable.
 */
const BEHIND_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local ttl = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local live = redis.call('HGETALL', KEYS[1])
local behind = 0
for i = 1, #live, 2 do
  local cut = string.find(live[i + 1], '|', 1, true)
  local lapse = cut and tonumber(string.sub(live[i + 1], 1, cut - 1))
  if lapse and lapse > now and lapse <= now + ttl and #live[i + 1] <= cap then
    local capable = tonumber(redis.call('HGET', KEYS[2], live[i]) or '')
    if (not capable) or capable <= now or capable > now + ttl then behind = behind + 1 end
  end
end
return behind
`;

export interface EntitlementPeers {
  /** Stops renewing and takes this node's field out. */
  readonly stop: () => Promise<void>;
}

interface Advertising {
  readonly link: RedisLink;
  /** The id this node announced its module set under: the two records are read together. */
  readonly nodeId: string;
  readonly log: Logger;
  readonly timers?: Timers;
}

/** Says, for as long as the node lives, that it reads what `hash` is the record of. */
const advertiseIn = (
  hash: string,
  what: string,
  { link, nodeId, log, timers = systemTimers }: Advertising,
): EntitlementPeers => {
  let stopped = false;
  let next: unknown;
  const renew = async (): Promise<void> => {
    let advertised = true;
    try {
      await link.script(ADVERTISE_SCRIPT, [hash], [nodeId, String(NODE_TTL_MS)]);
    } catch (error) {
      advertised = false;
      log.debug(`this node could not say that it reads ${what}`, { err: error });
    }
    if (!stopped) next = timers.set(() => void renew(), advertised ? RENEW_MS : ANNOUNCE_RETRY_MS);
  };
  void renew();
  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (next !== undefined) timers.clear(next);
      try {
        await link.send('HDEL', [hash, nodeId]);
      } catch (error) {
        log.debug(
          `this node’s capability to read ${what} could not be taken out of the shared record`,
          {
            err: error,
          },
        );
      }
    },
  };
};

export const advertiseEntitlements = (advertising: Advertising): EntitlementPeers =>
  advertiseIn(advertising.link.names.entitlementNodes, 'workspace grants', advertising);

/** How many live nodes are not in `hash`. Rejects when Redis cannot say: a restriction waits for an answer. */
const behindIn = async (link: RedisLink, hash: string): Promise<number> => {
  const answer = await link.script(
    BEHIND_SCRIPT,
    [link.names.moduleSet, hash],
    [String(NODE_TTL_MS), String(FIELD_MAX_CHARS)],
  );
  if (typeof answer !== 'number') throw new Error('the peers script answered something else');
  return answer;
};

/** How many live nodes do not read grants. Rejects when Redis cannot say: a restriction waits for an answer. */
export const peersBehind = async (link: RedisLink): Promise<number> =>
  await behindIn(link, link.names.entitlementNodes);

/** Says, as `advertiseEntitlements` does for grants, that this node reads the modules the administrator has stopped (D-296). */
export const advertiseSuspension = (advertising: Advertising): EntitlementPeers =>
  advertiseIn(advertising.link.names.suspensionNodes, 'the stopped modules', advertising);

/** How many live nodes do not read the stopped modules, which a stop waits to be none. */
export const suspensionPeersBehind = async (link: RedisLink): Promise<number> =>
  await behindIn(link, link.names.suspensionNodes);
