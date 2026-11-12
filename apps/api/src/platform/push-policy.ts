/** Durable delivery bounds (#1405): existing PostgreSQL, no additional transport or broker. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
export const PUSH_LEASE_MS = 60_000;
export const PUSH_ATTEMPTS_MAX = 8;
export const PUSH_PENDING_PER_PERSON = 1_000;
export const PUSH_POSTS_AT_ONCE = 16;
export const PUSH_POSTS_PER_PERSON = 2;
export const PUSH_PERSON_LOCK = 14_050_126;
export const NOTICE_PUSH_BUDGET = { perSecond: 1 / 60, burst: 3 } as const;
