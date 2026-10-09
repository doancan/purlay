/**
 * The highest message id held per channel — what a reconnect resumes from.
 *
 * UUIDv7s sort as text in the order they were made, so "the highest" is a string
 * comparison and the cursor needs no clock (D-8). The comparison is
 * case-insensitive because RFC 9562 allows either case and the server accepts
 * both; a mixed-case id compared as written would order by letter case.
 *
 * **A cursor is not a watermark** (D-65): a message can arrive with an id below
 * the one held. It only ever moves up here, and the server's replay starts
 * `REPLAY_OVERLAP_MS` beneath it for that reason.
 */
export interface Cursors {
  /** Note an id seen in `channelId`; the cursor moves only if it is higher. */
  readonly observe: (channelId: string, messageId: string) => void;
  /** The cursor for `channelId`, or `null` if nothing has been seen in it. */
  readonly get: (channelId: string) => string | null;
}

export const createCursors = (): Cursors => {
  const highest = new Map<string, string>();
  return {
    observe: (channelId, messageId): void => {
      const candidate = messageId.toLowerCase();
      const current = highest.get(channelId);
      if (current === undefined || candidate > current) highest.set(channelId, candidate);
    },
    get: (channelId): string | null => highest.get(channelId) ?? null,
  };
};
