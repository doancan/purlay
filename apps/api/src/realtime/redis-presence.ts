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
 *
 * **Idle** lives in the same hash (D-257): `a`, when any page of theirs last spoke, and `i`, whether they were
 * told idle. The idle index says when each person's quiet time comes; whoever sweeps first finds a person whose
 * time has come, still held and not yet told, and tells them away, once. A word on any node moves the time on,
 * and answers with a version only when it ended an idle that was told: so a person speaking on one node is
 * active however quiet another node's socket is, and a node that dies takes nothing of it with it. Somebody
 * nobody held arrives active; a second node, or a renewal, changes neither. Here `away` is idleness only: the
 * person's own choice is the announcer's to add.
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
 * KEYS: the person's claims, the lapse index, the idle index. ARGV: node, ttl, person, quiet allowed. A version
 * when nobody held them before, 0 when somebody did (this node renewing, or another). The lapse index says when
 * the person's last claim lapses, so that somebody can tell the room they are gone when nobody did
 * (`SWEEP_SCRIPT`). Somebody nobody held arrives active: their word is now, and their quiet time starts.
 */
const JOIN_SCRIPT = `${NOW}${LIVE}
local before = live(KEYS[1], now)
redis.call('HSET', KEYS[1], 'n:' .. ARGV[1], now + tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[3])
if before > 0 then return 0 end
redis.call('HSET', KEYS[1], 'a', now, 'i', 0)
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[4]), ARGV[3])
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
return version
`;

/**
 * KEYS: claims, lapse index, idle index. ARGV: node, person. A version when no node holds them now, 0 when
 * another still does. Gone, they are nobody's to tell idle.
 */
const LEAVE_SCRIPT = `${NOW}${LIVE}
redis.call('HDEL', KEYS[1], 'n:' .. ARGV[1])
local rest, latest = live(KEYS[1], now)
if rest > 0 then
  redis.call('ZADD', KEYS[2], latest, ARGV[2])
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2])
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
redis.call('PEXPIRE', KEYS[1], 60000)
return version
`;

/**
 * A node that is stopping gives its claim up: if nobody else holds the person, the index says they are due at
 * once, and the next sweep of any node tells the room — unless they have come back elsewhere meanwhile.
 * KEYS: claims, lapse index, idle index. ARGV: node, person.
 */
const RELEASE_SCRIPT = `${NOW}${LIVE}
redis.call('HDEL', KEYS[1], 'n:' .. ARGV[1])
if live(KEYS[1], now) == 0 then
  redis.call('ZADD', KEYS[2], now, ARGV[2])
  redis.call('ZREM', KEYS[3], ARGV[2])
end
return 1
`;

/**
 * A page of theirs spoke, on this node: their quiet time starts again. A version when this ended an idle that
 * was told, 0 otherwise — and nothing is kept for somebody nobody holds, whose next join starts them afresh.
 * KEYS: claims, idle index. ARGV: person, quiet allowed.
 */
const ACTIVE_SCRIPT = `${NOW}${LIVE}
if live(KEYS[1], now) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'a', now)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
if redis.call('HGET', KEYS[1], 'i') ~= '1' then return 0 end
redis.call('HSET', KEYS[1], 'i', 0)
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
return version
`;

/** Their state again, at a new version: {version, idle} when somebody holds them, {0, 0} when nobody does. KEYS: claims. */
const RETELL_SCRIPT = `${NOW}${LIVE}
if live(KEYS[1], now) == 0 then return {0, 0} end
local version = bump(KEYS[1], now)
redis.call('HSET', KEYS[1], 'v', version)
return {version, tonumber(redis.call('HGET', KEYS[1], 'i')) or 0}
`;

/**
 * Whoever finds a person whose last claim lapsed — a node that died, was stopped, or could not say they left —
 * and nobody told, tells: the version, once (the index entry goes with it). A person who has come back since
 * is only given their later lapse. Then whoever finds a person whose quiet time has come, still held and not
 * yet told idle, tells them away, once; anybody else's idle entry is only dropped (nobody holds them, or they
 * were told). Answers {person, version, away} for each: 0 is offline, 1 is online and idle.
 * KEYS: the lapse index, the idle index. ARGV: the claims' prefix, how many at most of each.
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
    redis.call('ZREM', KEYS[2], person)
    local version = bump(key, now)
    redis.call('HSET', key, 'v', version)
    redis.call('PEXPIRE', key, 60000)
    gone[#gone + 1] = person
    gone[#gone + 1] = version
    gone[#gone + 1] = 0
  end
end
local quiet = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, tonumber(ARGV[2]))
for _, person in ipairs(quiet) do
  local key = ARGV[1] .. person
  redis.call('ZREM', KEYS[2], person)
  if live(key, now) > 0 and redis.call('HGET', key, 'i') ~= '1' then
    redis.call('HSET', key, 'i', 1)
    local version = bump(key, now)
    redis.call('HSET', key, 'v', version)
    gone[#gone + 1] = person
    gone[#gone + 1] = version
    gone[#gone + 1] = 1
  end
end
return gone
`;

/** Two answers per key: the version and whether they were told idle when somebody holds them, 0 and 0 when nobody does. */
const AMONG_SCRIPT = `${NOW}${LIVE}
local answers = {}
for k = 1, #KEYS do
  if live(KEYS[k], now) > 0 then
    answers[2 * k - 1] = tonumber(redis.call('HGET', KEYS[k], 'v')) or now
    answers[2 * k] = tonumber(redis.call('HGET', KEYS[k], 'i')) or 0
  else
    answers[2 * k - 1] = 0
    answers[2 * k] = 0
  end
end
return answers
`;

export const TYPING_PREFIX = 'purlay:typing:';
export const ONLINE_PREFIX = 'purlay:online:';
export const LAPSE_INDEX = 'purlay:online-lapse';
/** When each person's quiet time comes, scored by Redis's clock (D-257). */
export const IDLE_INDEX = 'purlay:online-idle';
/** How many lapsed people, and how many idle, one sweep tells of. */
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

/** A script's `{version, idle}`: two numbers, idle 0 or 1. */
const asState = (version: unknown, idle: unknown): { version: number; away: boolean } => {
  if (typeof version !== 'number' || (idle !== 0 && idle !== 1)) {
    throw new Error('the presence script answered something else');
  }
  return { version, away: idle === 1 };
};

/** One of these per node: `nodeId` says which claims are this process's. */
export const redisPresenceDirectory = (link: RedisLink, nodeId: string): PresenceDirectory => ({
  join: async (userId, awayAfterMs) =>
    asVersion(
      await link.script(
        JOIN_SCRIPT,
        [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX, IDLE_INDEX],
        [nodeId, String(PRESENCE_NODE_TTL_MS), userId, String(awayAfterMs)],
      ),
    ),
  leave: async (userId) =>
    asVersion(
      await link.script(
        LEAVE_SCRIPT,
        [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX, IDLE_INDEX],
        [nodeId, userId],
      ),
    ),
  active: async (userId, awayAfterMs) =>
    asVersion(
      await link.script(
        ACTIVE_SCRIPT,
        [`${ONLINE_PREFIX}${userId}`, IDLE_INDEX],
        [userId, String(awayAfterMs)],
      ),
    ),
  retell: async (userId): Promise<PresenceChange | null> => {
    const answer = await link.script(RETELL_SCRIPT, [`${ONLINE_PREFIX}${userId}`], []);
    if (!Array.isArray(answer) || answer.length !== 2) {
      throw new Error('the presence script answered something else');
    }
    const { version, away } = asState(answer[0], answer[1]);
    return version === 0 ? null : { userId, online: true, away, version };
  },
  release: async (userIds): Promise<void> => {
    await Promise.all(
      userIds.map(
        async (userId) =>
          await link.script(
            RELEASE_SCRIPT,
            [`${ONLINE_PREFIX}${userId}`, LAPSE_INDEX, IDLE_INDEX],
            [nodeId, userId],
          ),
      ),
    );
  },
  sweep: async (): Promise<readonly PresenceChange[]> => {
    const answer = await link.script(
      SWEEP_SCRIPT,
      [LAPSE_INDEX, IDLE_INDEX],
      [ONLINE_PREFIX, String(SWEEP_BATCH)],
    );
    if (!Array.isArray(answer) || answer.length % 3 !== 0) {
      throw new Error('the presence script answered something else');
    }
    const found: PresenceChange[] = [];
    for (let at = 0; at < answer.length; at += 3) {
      const userId: unknown = answer[at];
      if (typeof userId !== 'string')
        throw new Error('the presence script answered something else');
      // Offline, or online and idle: never online and active, which nobody needs a sweep to tell.
      const { version, away } = asState(answer[at + 1], answer[at + 2]);
      found.push({ userId, online: away, away, version });
    }
    return found;
  },
  among: async (userIds): Promise<readonly PresenceChange[]> => {
    if (userIds.length === 0) return [];
    const answers = await link.script(
      AMONG_SCRIPT,
      userIds.map((userId) => `${ONLINE_PREFIX}${userId}`),
      [],
    );
    if (!Array.isArray(answers) || answers.length !== 2 * userIds.length) {
      throw new Error('the presence script answered something else');
    }
    return userIds.flatMap((userId, index): PresenceChange[] => {
      const { version, away } = asState(answers[2 * index], answers[2 * index + 1]);
      return version === 0 ? [] : [{ userId, online: true, away, version }];
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
