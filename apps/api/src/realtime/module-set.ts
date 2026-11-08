/**
 * Which modules each node of a cluster runs, and how it reads workspace grants (`WORKSPACE_MODULES`), and a line in the log when
 * they are not the same (D-250, D-289).
 *
 * Every node of a cluster runs one `MODULES` set (`CONFIG.md`), but a rolling deploy that changes it has
 * nodes of two sets for as long as it takes. So a mismatch is **said, never acted on**: the node keeps
 * serving, readiness does not change, and a log line names this node's set and the others', once when it
 * starts and once when it ends. What would be wrong across the two is small: the bus carries frames by
 * topic, and a socket of a node that does not run a module drops the events the module's manifest lists
 * (`hub.ts`) — a person's own topic is held by every socket, so the topic alone would not keep them out — and a node that does not run a module closes its routes (the plain `404`). A bus
 * channel per set would be worse — a sign-out on one node would no longer close the sockets of another.
 *
 * Each node keeps one field in a shared hash, `node -> lapse time|set`, renewed every `RENEW_MS` and
 * lapsing by itself after `NODE_TTL_MS`, so a node that dies stops counting; a node that stops cleanly
 * removes its own. One script writes this node's field, drops the lapsed ones and answers the distinct sets
 * of the rest, on Redis's clock.
 */
import type { Logger } from '../platform/logging';
import type { EntitlementMode } from '../platform/module-kit/entitlement';
import type { RedisLink } from '../platform/redis';
import { systemTimers, type Timers } from './hub';

export const NODE_TTL_MS = 30_000;
const RENEW_MS = NODE_TTL_MS / 3;
/** Between a failed announcement and the next: a process announces as it starts, before its connection is up. */
export const ANNOUNCE_RETRY_MS = 1_000;

/** A set as one word: the ids in order, or `none` for the core alone. The same modules are the same word. */
export const moduleSetOf = (ids: readonly string[]): string =>
  ids.length === 0 ? 'none' : [...ids].sort().join(',');

/** KEYS: the hash. ARGV: node, set, ttl. Answers the distinct sets of the live nodes, this one's included. */
const ANNOUNCE_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local ttl = tonumber(ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], (now + ttl) .. '|' .. ARGV[2])
redis.call('PEXPIRE', KEYS[1], ttl)
local all = redis.call('HGETALL', KEYS[1])
local seen = {}
local sets = {}
for i = 1, #all, 2 do
  local cut = string.find(all[i + 1], '|', 1, true)
  if tonumber(string.sub(all[i + 1], 1, cut - 1)) <= now then
    redis.call('HDEL', KEYS[1], all[i])
  else
    local set = string.sub(all[i + 1], cut + 1)
    if not seen[set] then
      seen[set] = true
      sets[#sets + 1] = set
    end
  end
end
return sets
`;

export interface ModuleSetWatch {
  /** Stops asking and takes this node's field out, so a node that left is not a mismatch for the next thirty seconds. */
  readonly stop: () => Promise<void>;
}

/**
 * What a node announces: its set and its `WORKSPACE_MODULES`, as `set|mode`. A node of an earlier release announces the set alone,
 * which is the same set and no word about the mode.
 */
const wordOf = (set: string, mode: EntitlementMode): string => `${set}|${mode}`;
const parts = (word: string): { set: string; mode: string | undefined } => {
  const at = word.indexOf('|');
  return at === -1
    ? { set: word, mode: undefined }
    : { set: word.slice(0, at), mode: word.slice(at + 1) };
};

export interface ModuleSetOptions {
  readonly link: RedisLink;
  readonly nodeId: string;
  readonly set: string;
  /** `WORKSPACE_MODULES`: a node on `open` serves a module no grant names, a node on `managed` does not, so nodes of a cluster must agree. */
  readonly mode: EntitlementMode;
  readonly log: Logger;
  readonly timers?: Timers;
}

export const watchModuleSet = ({
  link,
  nodeId,
  set,
  mode,
  log,
  timers = systemTimers,
}: ModuleSetOptions): ModuleSetWatch => {
  const word = wordOf(set, mode);
  let mismatched = false;
  let disagreed = false;
  let stopped = false;
  let next: unknown;

  /** Whether the record now has this node; a node it does not have is asked again soon. */
  const announce = async (): Promise<boolean> => {
    try {
      const answer = await link.script(
        ANNOUNCE_SCRIPT,
        [link.names.moduleSet],
        [nodeId, word, String(NODE_TTL_MS)],
      );
      if (!Array.isArray(answer)) throw new Error('the module-set script answered something else');
      const others = (answer as string[]).filter((one) => one !== word).map(parts);
      const otherSets = others.filter((one) => one.set !== set).map((one) => one.set);
      const otherModes = others.flatMap((one) =>
        one.mode === undefined || one.mode === mode ? [] : [one.mode],
      );
      if (otherSets.length > 0 && !mismatched) {
        log.warn(
          'the nodes of this cluster do not run the same modules; serving on, as in a rolling deploy',
          { thisNode: set, otherNodes: otherSets, see: 'CONFIG.md, MODULES' },
        );
      }
      if (otherSets.length === 0 && mismatched) {
        log.info('the nodes of this cluster run the same modules again', { set });
      }
      mismatched = otherSets.length > 0;
      if (otherModes.length > 0 && !disagreed) {
        log.warn(
          'the nodes of this cluster do not agree on WORKSPACE_MODULES; a module withheld from a workspace is served on the nodes that read it as open',
          { thisNode: mode, otherNodes: otherModes, see: 'CONFIG.md, WORKSPACE_MODULES' },
        );
      }
      if (otherModes.length === 0 && disagreed) {
        log.info('the nodes of this cluster agree on WORKSPACE_MODULES again', { mode });
      }
      disagreed = otherModes.length > 0;
      return true;
    } catch (error) {
      // Redis being away is the link's to say; a node that cannot compare has nothing to warn of.
      log.debug('the modules this cluster runs could not be compared', { err: error });
      return false;
    }
  };

  const loop = async (): Promise<void> => {
    const announced = await announce();
    if (!stopped) next = timers.set(() => void loop(), announced ? RENEW_MS : ANNOUNCE_RETRY_MS);
  };
  void loop();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (next !== undefined) timers.clear(next);
      try {
        await link.send('HDEL', [link.names.moduleSet, nodeId]);
      } catch (error) {
        log.debug('this node’s modules could not be taken out of the shared record', {
          err: error,
        });
      }
    },
  };
};
