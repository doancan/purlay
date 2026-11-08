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
import { ANNOUNCE_RETRY_MS, NODE_TTL_MS } from './module-set';

const RENEW_MS = NODE_TTL_MS / 3;

/** KEYS: the hash of capable nodes. ARGV: node, ttl. */
const ADVERTISE_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('HSET', KEYS[1], ARGV[1], now + tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  if tonumber(all[i + 1]) <= now then redis.call('HDEL', KEYS[1], all[i]) end
end
return 1
`;

/** KEYS: the module-set hash (`node -> lapse|set`), the hash of capable nodes. Answers how many live nodes are not in the second. */
const BEHIND_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local live = redis.call('HGETALL', KEYS[1])
local behind = 0
for i = 1, #live, 2 do
  local cut = string.find(live[i + 1], '|', 1, true)
  if tonumber(string.sub(live[i + 1], 1, cut - 1)) > now then
    local lapse = redis.call('HGET', KEYS[2], live[i])
    if (not lapse) or tonumber(lapse) <= now then behind = behind + 1 end
  end
end
return behind
`;

export interface EntitlementPeers {
  /** Stops renewing and takes this node's field out. */
  readonly stop: () => Promise<void>;
}

export const advertiseEntitlements = ({
  link,
  nodeId,
  log,
  timers = systemTimers,
}: {
  readonly link: RedisLink;
  /** The id this node announced its module set under: the two records are read together. */
  readonly nodeId: string;
  readonly log: Logger;
  readonly timers?: Timers;
}): EntitlementPeers => {
  let stopped = false;
  let next: unknown;
  const renew = async (): Promise<void> => {
    let advertised = true;
    try {
      await link.script(
        ADVERTISE_SCRIPT,
        [link.names.entitlementNodes],
        [nodeId, String(NODE_TTL_MS)],
      );
    } catch (error) {
      advertised = false;
      log.debug('this node could not say that it reads workspace grants', { err: error });
    }
    if (!stopped) next = timers.set(() => void renew(), advertised ? RENEW_MS : ANNOUNCE_RETRY_MS);
  };
  void renew();
  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (next !== undefined) timers.clear(next);
      try {
        await link.send('HDEL', [link.names.entitlementNodes, nodeId]);
      } catch (error) {
        log.debug('this node’s grants capability could not be taken out of the shared record', {
          err: error,
        });
      }
    },
  };
};

/** How many live nodes do not read grants. Rejects when Redis cannot say: a restriction waits for an answer. */
export const peersBehind = async (link: RedisLink): Promise<number> => {
  const answer = await link.script(
    BEHIND_SCRIPT,
    [link.names.moduleSet, link.names.entitlementNodes],
    [],
  );
  if (typeof answer !== 'number') throw new Error('the peers script answered something else');
  return answer;
};
