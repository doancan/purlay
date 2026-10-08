/**
 * String formats, registered.
 *
 * TypeBox does not validate an unregistered `format` — it **rejects every value**
 * for it, valid ones included. Relying on the server framework to register them
 * would mean the contract validated inside the API and refused everything in a
 * test or a client, which surfaces as a mystery rather than as an error.
 *
 * So the contract registers its own, and validates identically wherever it is
 * used. `formats.test.ts` fails if this module stops being imported.
 */
import { FormatRegistry } from '@sinclair/typebox';

/**
 * Shape only. That a `messages.id` is specifically a UUIDv7 carrying a plausible
 * timestamp is checked by the server before it trusts a client-supplied id
 * (D-33) — a rule about time, not a string format.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deliberately narrow: an address the application produced, in UTC. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Not RFC 5322. An email regular expression that tries to be complete is a
 * well-known way to reject valid addresses; the real check is that a message
 * sent to it arrives, and GitHub already did that (D-38).
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An absolute URL with a scheme. `APP_URL` is the one that matters. */
const URI = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i;

/**
 * Everything JSON escapes to six bytes, in one pass: a C0 control character other
 * than tab, line feed and carriage return, or a surrogate without its partner.
 * Neither occurs in text a person typed or pasted.
 *
 * A pattern rather than `String.prototype.isWellFormed`, which is ES2024 and would
 * move the whole repository's library target for one call — and one linear scan
 * rather than two.
 */
const INFLATES_IN_JSON =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Message text. Excluding exactly what JSON inflates to six bytes is what bounds
 * a message on the wire at three bytes per code unit, so the length limit can be
 * proven to fit the frame cap rather than hoped to (D-67).
 */
const isMessageContent = (value: string): boolean => !INFLATES_IN_JSON.test(value);

FormatRegistry.Set('uuid', (value) => UUID.test(value));
FormatRegistry.Set('date-time', (value) => DATE_TIME.test(value));
FormatRegistry.Set('email', (value) => EMAIL.test(value));
FormatRegistry.Set('uri', (value) => URI.test(value));
FormatRegistry.Set('message-content', isMessageContent);

export const REGISTERED_FORMATS = ['uuid', 'date-time', 'email', 'uri', 'message-content'] as const;
