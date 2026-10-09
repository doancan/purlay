/**
 * The client's clock, as a dependency.
 *
 * `apps/web` cannot import the API's `platform/clock.ts`, and the rule behind it
 * holds here too: behaviour that depends on the time — drift correction, backoff,
 * an ACK deadline — is untestable if it reads the time itself. This is only the
 * shape. What reads the real clock is wired where the client is assembled, with
 * the first code that needs one. (D-46)
 */
export interface Clock {
  readonly now: () => Date;
}
