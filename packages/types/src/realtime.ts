/**
 * What a client of the realtime protocol has to know that the frames do not say: how long to wait, how
 * often to ask and how much to keep. Not restated by any client — the browser's reads these, and so does
 * the macOS application's, generated from the contract bundle (`DECISIONS.md` D-186, `OVERVIEW.md`).
 *
 * They are the rules of `ARCHITECTURE.md` §5.3 – §5.5 as numbers. A number copied into a second client is
 * a number that will eventually disagree with itself (`CONTRIBUTING.md` §6.1), and what one client does at
 * these numbers the server meets from the other.
 */

/**
 * How long to wait before the next reconnect attempt (`ARCHITECTURE.md` §5.4).
 *
 * Exponential from one second, capped at thirty, so a server that is down is
 * not hammered. Jittered, because every client of a server that restarted lost
 * its connection at the same instant: without jitter they all come back at 1 s,
 * then all at 2 s, and the server meets the whole room in lockstep. (D-76)
 */
export const BACKOFF = { baseMs: 1_000, capMs: 30_000 } as const;
/**
 * How long a connection must hold before the backoff forgives it.
 *
 * Without this a server that accepts and then drops every connection is
 * "successfully connected" each time, and is retried at the shortest delay
 * forever. Long enough to outlast a handshake and a first replay; short enough
 * that a healthy reconnect is not penalised for the outage before it. (D-76)
 */
export const STABLE_AFTER_MS = 10_000;
/**
 * How long a connection may say nothing before it is asked whether it is there.
 *
 * Under the 60 s idle timeout that proxies and load balancers commonly apply to
 * a connection carrying nothing, so a quiet channel does not get the socket
 * closed from outside; and a busy connection is never pinged at all, because
 * every inbound frame counts as proof of life and restarts this wait. (D-82)
 */
export const PING_AFTER_IDLE_MS = 25_000;
/**
 * How long a `PING` may go unanswered — by anything — before the socket is
 * declared dead.
 *
 * A half-open socket (a sleeping laptop, a dead NAT mapping, a mobile handoff)
 * reads `open` until the operating system's TCP timeout, which is minutes. Fifteen
 * seconds outlasts a retransmission or two on a poor mobile link, and keeps the
 * worst case — silence, then this — at 40 s. (D-82)
 */
export const PONG_DEADLINE_MS = 15_000;
/**
 * How many handshakes in a row may fail before reaching `open` before the
 * session is asked about.
 *
 * The browser hides why a handshake failed — a refusal (401) and an outage both
 * surface as close code 1006 — so the only way to tell them apart is to ask the
 * API. Three failures is past a single dropped connection or a server restart,
 * and early enough that a signed-out user retries for seconds, not forever. (D-82)
 */
export const CHECK_SESSION_AFTER_FAILURES = 3;
/**
 * Where on the backoff ladder a `TOO_BUSY` close starts the wait.
 *
 * The server closes with 1013 — *try again later* — when it was handed more than
 * it could take in turn. Coming back after the first rung (half a second to a
 * second) is coming back into the same pile; the fourth (4–8 s) lets the queue
 * that caused it drain. It only ever raises the failures already counted, so a
 * long outage keeps its longer wait. Pacing (`subscribe`) is what keeps a healthy
 * client from earning this at all. (D-82)
 */
export const TOO_BUSY_BACKOFF_STEP = 3;
/** How long a send may wait for its ACK before it is shown as failed (`UX.md` §3.1). */
export const ACK_DEADLINE_MS = 3_000;
/**
 * How long a replay continuation waits before it asks again, and so how many times it tries:
 * one more attempt after each wait. Capped — a feed with a hole in it is better refetched
 * whole than chased forever — and short, because the person is looking at the channel.
 */
export const REPLAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * How many unsent messages a client keeps across a reload, and about how many characters they may hold
 * between them, newest kept. A store that fills the browser's quota makes the next draft fail to save
 * instead (`pending-store.ts`); the application's file is held to the same bounds, so what one client may
 * lose is what the other may.
 */
export const OUTBOX_MAX_MESSAGES = 50;
export const OUTBOX_MAX_CHARS = 200_000;
