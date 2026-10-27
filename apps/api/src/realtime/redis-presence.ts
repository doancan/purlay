/**
 * Presence several nodes share (D-201, D-25): who is typing where, and who is online.
 *
 * **Typing** is one key per person per channel holding when the room was last told, expiring with the
 * window. The script is the in-memory registry's rule (`presence.ts`) on Redis's clock: tell the room when
 * there is no window or the last telling is half spent, so a person typing on two nodes costs one frame per
 * half window, not one per node. Unreachable, it answers *tell*: a frame too many, never a wrong answer.
 *
 * **Online** is one hash per person: a claim per node holding a socket of theirs, each with the time it
 * lapses, and the version of the last change. A claim lapses by itself, so a node that dies leaves nobody
 * online for more than `PRESENCE_NODE_TTL_MS` (live nodes renew theirs, `online.ts`). `join` and `leave`
 * answer with a new version only when they changed whether the person is online anywhere, which is what
 * decides whether anyone is told. Versions come from Redis's clock and only grow (`max(now + 1, last + 1)`),
 * so two nodes with clocks apart still agree on which change is later, and a snapshot taken at `TIME` is
 * smaller than every change after it.
 */
import type { PresenceChange } from '@purlay/types';
import type { Logger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import { PRESENCE_NODE_TTL_MS, type PresenceDirectory } from './online';
import type { PresenceRegistry } from './presence';

const NOW = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
`;

const TYPING_SCRIPT = `${NOW}
local ttl = tonumber(ARGV[1])
local at = tonumber(redis.call('GET', KEYS[1]))
if at ~= nil and now - at < ttl / 2 then return 0 end
redis.call('SET', KEYS[1], tostring(now), 'PX', ttl)
return 1
`;

/** Counts the live claims on a person, dropping the lapsed ones, and says when the last of them lapses. */
const LIVE = `
local function live(key, now)
  local all = redis.call('HGETALL', key)
  local count = 0
  local latest = 0
  for i = 1, #all, 2 do
    if string.sub(all[i], 1, 2) == 'n:' then
      local lapses = tonumber(all[i + 1])
      if lapses <= now then
        redis.call('HDEL', key, all[i])
      else
        count = count + 1
        if lapses > latest then latest = lapses end
      end
    end
  end
  return count, latest
end
local function bump(key, now)
  return math.max(now + 1, (tonumber(redis.call('HGET', key, 'v')) or 0) + 1)
end
`;

/**
 * KEYS: the person's claims, the lapse index. ARGV: node, ttl, person. A version when nobody held them before,
 * 0 when somebody did (this node renewing, or another). The index says when the person's last claim lapses, so
 * that somebody can tell the room they are gone when nobody did (`SWEEP_SCRIPT`).
 */
const JOIN_SCRIPT = `${NOW}${LIVE}
local before = live(KEYS[1], now)
redis.call('HSET', KEYS[1], 'n:' .. ARGV[1], now + tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[3])
if before > 0 then return 0 end
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
return version
`;

/** KEYS: claims, index. ARGV: node, person. A version when no node holds them now, 0 when another still does. */
const LEAVE_SCRIPT = `${NOW}${LIVE}
redis.call('HDEL', KEYS[1], 'n:' .. ARGV[1])
local rest, latest = live(KEYS[1], now)
if rest > 0 then
  redis.call('ZADD', KEYS[2], latest, ARGV[2])
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[2])
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
redis.call('PEXPIRE', KEYS[1], 60000)
return version
`;

/**
 * A node that is stopping gives its claim up: if nobody else holds the person, the index says they are due at
 * once, and the next sweep of any node tells the room — unless they have come back elsewhere meanwhile.
 * KEYS: claims, index. ARGV: node, person.
 */
const RELEASE_SCRIPT = `${NOW}${LIVE}
redis.call('HDEL', KEYS[1], 'n:' .. ARGV[1])
if live(KEYS[1], now) == 0 then redis.call('ZADD', KEYS[2], now, ARGV[2]) end
return 1
`;

/**
 * Whoever finds a person whose last claim lapsed — a node that died, was stopped, or could not say they left —
 * and nobody told, tells: the version, once (the index entry goes with it). A person who has come back since
 * is only given their later lapse. KEYS: the index. ARGV: the claims' prefix, how many at most.
 */
const SWEEP_SCRIPT = `${NOW}${LIVE}
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[2]))
local gone = {}
for _, person in ipairs(due) do
  local key = ARGV[1] .. person
  local rest, latest = live(key, now)
  if rest > 0 then
    redis.call('ZADD', KEYS[1], latest, person)
  else
    redis.call('ZREM', KEYS[1], person)
    local version = bump(key, now)
    redis.call('HSET', key, 'v', version)
    redis.call('PEXPIRE', key, 60000)
    gone[#gone + 1] = person
    gone[#gone + 1] = version
  end
end
return gone
`;

/** One answer per key: the version when somebody holds them, 0 when nobody does. */
const AMONG_SCRIPT = `${NOW}${LIVE}
local answers = {}
for i = 1, #KEYS do
  if live(KEYS[i], now) > 0 then
    answers[i] = tonumber(redis.call('HGET', KEYS[i], 'v')) or now
  else
    answers[i] = 0
  end
end
return answers
`;

export const TYPING_PREFIX = 'purlay:typing:';
export const ONLINE_PREFIX = 'purlay:online:';
export const LAPSE_INDEX = 'purlay:online-lapse';
/** How many lapsed people one sweep tells of. */
const SWEEP_BATCH = 100;

export const redisPresenceRegistry = (
  link: RedisLink,
  log: Logger,
  /** What answers while Redis does not: this node's own windows, which still keep a typist to a frame per half window. */
  local: PresenceRegistry,
): PresenceRegistry => ({
  startTyping: async (channelId, userId, ttlMs): Promise<boolean> => {
    try {
      const answer = await link.script(
        TYPING_SCRIPT,
        [`${TYPING_PREFIX}${channelId}:${userId}`],
        [String(ttlMs)],
      );
      if (answer === 0) return false;
      if (answer === 1) return true;
      throw new Error('the typing script answered something else');
    } catch (error) {
      (link.connected() ? log.warn : log.debug)(
        'the shared typing record could not answer; using this node’s own window',
        { err: error },
      );
      return await local.startTyping(channelId, userId, ttlMs);
    }
  },
  stopTyping: (channelId, userId): void => {
    local.stopTyping(channelId, userId);
    // Not waited for: the send has been answered, and the window ends by itself within its length.
    link.send('DEL', [`${TYPING_PREFIX}${channelId}:${userId}`]).catch((error: unknown) => {
      log.debug('a typing window could not be ended early', { err: error });
    });
  },
});

const asVersion = (answer: unknown): number | null => {
  if (typeof answer !== 'number') throw new Error('the presence script answered something else');
  return answer === 0 ? null : answer;
};

/** One of these per node: `nodeId` says which claims are this process's. */
export const redisPresenceDirectory = (link: RedisLink, nodeId: string): PresenceDirectory => ({
  join: async (userId) =>
    asVersion(
      await link.script(
        JOIN_SCRIPT,
        [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX],
        [nodeId, String(PRESENCE_NODE_TTL_MS), userId],
      ),
    ),
  leave: async (userId) =>
    asVersion(
      await link.script(LEAVE_SCRIPT, [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX], [nodeId, userId]),
    ),
  release: async (userIds): Promise<void> => {
    await Promise.all(
      userIds.map(
        async (userId) =>
          await link.script(
            RELEASE_SCRIPT,
            [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX],
            [nodeId, userId],
          ),
      ),
    );
  },
  sweep: async (): Promise<readonly PresenceChange[]> => {
    const answer = await link.script(
      SWEEP_SCRIPT,
      [LAPSE_INDEX],
      [ONLINE_PREFIX, String(SWEEP_BATCH)],
    );
    if (!Array.isArray(answer) || answer.length % 2 !== 0) {
      throw new Error('the presence script answered something else');
    }
    const gone: PresenceChange[] = [];
    for (let at = 0; at < answer.length; at += 2) {
      const userId: unknown = answer[at];
      const version: unknown = answer[at + 1];
      if (typeof userId !== 'string' || typeof version !== 'number') {
        throw new Error('the presence script answered something else');
      }
      gone.push({ userId, online: false, version });
    }
    return gone;
  },
  among: async (userIds): Promise<readonly PresenceChange[]> => {
    if (userIds.length === 0) return [];
    const answers = await link.script(
      AMONG_SCRIPT,
      userIds.map((userId) => `${ONLINE_PREFIX}${userId}`),
      [],
    );
    if (!Array.isArray(answers) || answers.length !== userIds.length) {
      throw new Error('the presence script answered something else');
    }
    return userIds.flatMap((userId, index): PresenceChange[] => {
      const version: unknown = answers[index];
      if (typeof version !== 'number')
        throw new Error('the presence script answered something else');
      return version === 0 ? [] : [{ userId, online: true, version }];
    });
  },
  version: async (): Promise<number> => {
    const reply = await link.send('TIME', []);
    const seconds: unknown = Array.isArray(reply) ? reply[0] : undefined;
    const micros: unknown = Array.isArray(reply) ? reply[1] : undefined;
    const sec = Number(seconds);
    const us = Number(micros);
    if (!Number.isFinite(sec) || !Number.isFinite(us)) {
      throw new Error('the server clock answered something else');
    }
    return sec * 1000 + Math.floor(us / 1000);
  },
});
