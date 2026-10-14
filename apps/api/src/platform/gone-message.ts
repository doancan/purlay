/**
 * A message gone from under a write that referred to it (D-139 §2): the retention purge took a root
 * while a reply, a reaction, a pin, a save or a read of it was on its way, and the database refused the
 * reference. That is the message not found — as it would have been a moment earlier — on HTTP and on
 * the socket alike, never a `500`: nobody did anything wrong.
 *
 * The same refusal is what a write pairing a message with the wrong channel or workspace meets (the
 * composite keys exist to catch that, I-1, I-3, I-4), so each one is logged by its constraint's name:
 * a quiet `404` must not hide the defence in depth doing its job.
 */

/** `foreign_key_violation`. */
const FOREIGN_KEY = '23503';

/**
 * Every foreign key that points at a message, bound to the database's own list by
 * `ingress/http/errors.integration.test.ts`: a key added later is a `500` until it is listed here.
 */
export const MESSAGE_REFERENCES: ReadonlySet<string> = new Set([
  'attachments_message_channel_fkey',
  'attachments_message_workspace_fkey',
  'channel_members_last_read_channel_fkey',
  'mentions_message_channel_fkey',
  'mentions_message_id_fkey',
  'message_versions_message_channel_fkey',
  'messages_parent_channel_fkey',
  'notifications_message_channel_fkey',
  'notifications_message_id_fkey',
  'pinned_messages_message_channel_fkey',
  'reactions_message_id_fkey',
  'saved_messages_message_channel_fkey',
]);

/**
 * The name of the reference refused, when this error is a write referring to a message that is not
 * there; otherwise `undefined`. Read by shape: this layer does not import the driver.
 */
export const goneMessageReference = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !('code' in error) || error.code !== FOREIGN_KEY) {
    return undefined;
  }
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return typeof constraint === 'string' && MESSAGE_REFERENCES.has(constraint)
    ? constraint
    : undefined;
};

/** What the client is told: the contract's own words for a message that is not there. */
export const MESSAGE_GONE = { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' } as const;
