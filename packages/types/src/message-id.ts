/**
 * What a message id is, and how to make one.
 *
 * `messages.id` is a **UUIDv7 the client generates**, so the optimistic row and
 * the durable row share one value and a message never moves in the list when its
 * acknowledgement lands (D-8). It is also the pagination cursor, which is why
 * getting it wrong is permanent: the value becomes a primary key.
 *
 * **The generator and the rule live together on purpose.** They are two halves of
 * one fact — the client makes ids the server must accept — and separating them is
 * how a window widens on one side and not the other. A test generates ids and
 * validates them, so the halves cannot drift.
 *
 * This is executable rather than a schema, which `CONTRIBUTING.md` §1.4 does not
 * anticipate. It lives here because both sides need it and neither may own it:
 * `apps/web` cannot import from `apps/api`, and a copy in each is exactly the
 * duplication the rule exists to prevent.
 */

/**
 * How far out of step a client's clock may be.
 *
 * Generous behind, because a laptop that has been asleep has not synced yet.
 * Tight ahead, because an id from the future pins itself above every message that
 * follows and **breaks keyset pagination for every reader** — `id < cursor` then
 * skips real rows. (D-33)
 */
export const MESSAGE_ID_SKEW = { behindMs: 60_000, aheadMs: 5_000 } as const;

const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shape only: version nibble `7`, RFC-conformant variant bits.
 *
 * A v4 id in a channel makes that channel's ordering wrong forever, and no later
 * migration can recover the intent — so this is checked at the boundary rather
 * than assumed from the `uuid` format, which only asserts *this is a UUID*.
 */
export const isMessageIdShape = (value: string): boolean => HEX.test(value);

/** The embedded millisecond timestamp. Meaningless unless the shape is right. */
export const messageIdTime = (value: string): number =>
  Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);

/** Both halves of D-33's rule: the shape, and a timestamp close enough to now. */
export const isPlausibleMessageId = (value: string, now: Date): boolean => {
  if (!isMessageIdShape(value)) return false;
  const embedded = messageIdTime(value);
  const current = now.getTime();
  return (
    embedded >= current - MESSAGE_ID_SKEW.behindMs && embedded <= current + MESSAGE_ID_SKEW.aheadMs
  );
};

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

/**
 * A UUIDv7 for a given instant.
 *
 * The clock is an argument for the same reason it is everywhere else: a value
 * derived from the current time is untestable when it reads the current time
 * itself. The client corrects `now` against the server's clock before calling
 * this (D-8, issue #21) — which is why the correction has somewhere to apply.
 */
export const messageId = (now: Date): string => {
  const milliseconds = now.getTime();
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);

  // 48 bits of time, then 4 bits of version, then 74 bits of randomness with the
  // two variant bits fixed — the layout RFC 9562 specifies for version 7.
  const timeHigh = hex(Math.floor(milliseconds / 0x1_0000), 8);
  const timeLow = hex(milliseconds % 0x1_0000, 4);
  const versioned = `7${hex(((random[0] ?? 0) << 4) | ((random[1] ?? 0) >> 4), 3).slice(-3)}`;
  const variant = hex(0x80 | ((random[2] ?? 0) & 0x3f), 2) + hex(random[3] ?? 0, 2);
  const tail = Array.from(random.slice(4), (byte) => hex(byte, 2)).join('');

  return `${timeHigh}-${timeLow}-${versioned}-${variant}-${tail}`;
};

/**
 * How far before a client's cursor a replay starts, so that nothing is lost.
 *
 * A cursor is not a watermark. The server accepts an id up to `behindMs` older
 * than its own clock, so a message written *after* a client last heard anything
 * can sort *below* the newest id that client holds — a send that waited out a
 * dropped connection does exactly this. Such a message still has an id no older
 * than the moment the client stopped listening, minus `behindMs`; and the cursor
 * is no newer than that moment plus `aheadMs`. Starting the replay this far below
 * the cursor therefore reaches every message the client can have missed.
 *
 * Derived rather than written, so widening the window widens the overlap with
 * it. The cost is re-sending what the client already holds from that stretch,
 * which a client keeping messages by id discards (D-65).
 */
export const REPLAY_OVERLAP_MS = MESSAGE_ID_SKEW.behindMs + MESSAGE_ID_SKEW.aheadMs;

/** The lowest UUIDv7 at an instant: every id made at or after it sorts above it. */
export const messageIdFloor = (milliseconds: number): string => {
  const clamped = Math.max(0, milliseconds);
  return `${hex(Math.floor(clamped / 0x1_0000), 8)}-${hex(clamped % 0x1_0000, 4)}-7000-8000-000000000000`;
};
