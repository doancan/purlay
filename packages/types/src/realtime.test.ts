import { describe, expect, test } from 'bun:test';
import {
  ACK_DEADLINE_MS,
  BACKOFF,
  CHECK_SESSION_AFTER_FAILURES,
  OUTBOX_MAX_CHARS,
  OUTBOX_MAX_MESSAGES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  REPLAY_RETRY_DELAYS_MS,
  STABLE_AFTER_MS,
  TOO_BUSY_BACKOFF_STEP,
} from './realtime';

// These are the numbers `ARCHITECTURE.md` §5.3 – §5.5 states in words, which every client now reads from here:
// a change is a change to the protocol, so the values are pinned and so are the relations between them that
// the protocol depends on.
describe('what a realtime client has to know', () => {
  test('the values the protocol states', () => {
    expect(ACK_DEADLINE_MS).toBe(3_000);
    expect(BACKOFF).toEqual({ baseMs: 1_000, capMs: 30_000 });
    expect(PING_AFTER_IDLE_MS).toBe(25_000);
    expect(PONG_DEADLINE_MS).toBe(15_000);
    expect(STABLE_AFTER_MS).toBe(10_000);
    expect(CHECK_SESSION_AFTER_FAILURES).toBe(3);
    expect(TOO_BUSY_BACKOFF_STEP).toBe(3);
    expect(REPLAY_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000]);
    expect(OUTBOX_MAX_MESSAGES).toBe(50);
    expect(OUTBOX_MAX_CHARS).toBe(200_000);
  });

  test('a silent socket is found dead inside a minute, under the idle timeout a proxy applies', () => {
    // D-82: the worst case — silence, then the wait for a pong — is 40 s, and the ping comes before the
    // 60 s a proxy tolerates in a connection that carries nothing.
    expect(PING_AFTER_IDLE_MS).toBeLessThan(60_000);
    expect(PING_AFTER_IDLE_MS + PONG_DEADLINE_MS).toBeLessThanOrEqual(60_000);
  });

  test('a send is failed before the first reconnect could have brought it back', () => {
    expect(ACK_DEADLINE_MS).toBeGreaterThan(BACKOFF.baseMs);
  });

  test('the backoff climbs to a cap, and a connection is forgiven only after outlasting a handshake', () => {
    expect(BACKOFF.baseMs).toBeLessThan(BACKOFF.capMs);
    expect(STABLE_AFTER_MS).toBeGreaterThan(BACKOFF.baseMs);
  });

  test('a replay is chased a few times and then read whole: the waits grow and are short', () => {
    expect([...REPLAY_RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual([...REPLAY_RETRY_DELAYS_MS]);
    expect(Math.max(...REPLAY_RETRY_DELAYS_MS)).toBeLessThanOrEqual(10_000);
  });

  test('a too-busy close starts the wait on a rung of the ladder that exists', () => {
    expect(BACKOFF.baseMs * 2 ** TOO_BUSY_BACKOFF_STEP).toBeLessThanOrEqual(BACKOFF.capMs);
  });
});
