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
 * Shape only — and **lower-case only**. Every id this system makes is lower-case hex
 * (PostgreSQL's text form, `crypto.randomUUID`, our UUIDv7), and every place that compares
 * one does it as text: the read position (`id <= position`), `dm_key` (a CHECK on the form,
 * I-5), topic names, a client's cache keys. A format that also accepted `ABC…` let a request
 * through the boundary that each of those then handled differently — a direct message
 * refused as malformed, a read position silently not moved, a frame published to a topic
 * nobody listens on. One spelling is refused at the one place that can say so (H-API 2).
 *
 * That a `messages.id` is specifically a UUIDv7 carrying a plausible
 * timestamp is checked by the server before it trusts a client-supplied id
 * (D-33) — a rule about time, not a string format.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/**
 * What a name may not contain: every control character (C0, DEL, C1 — a name is
 * one line, so tab, line feed and carriage return go too, and NUL, which
 * PostgreSQL cannot store, with them), the line and paragraph separators, a
 * lone surrogate, and the bidirectional embeddings, overrides and isolates
 * (U+202A-202E, U+2066-2069).
 *
 * The last are refused because a name is an identifier people read and compare by
 * eye: `gpj<RLO>exe.txt` displays as `gpjtxt.exe`-style spoofs, and an isolate
 * left open reorders the text around it. The directional *marks* (U+200E/200F)
 * stay: a right-to-left name in a left-to-right sidebar legitimately needs one.
 */
const FORBIDDEN_IN_NAME =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Free text that may span lines (a topic): what PostgreSQL stores, nothing more. */
const NOT_STORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isPlainText = (value: string): boolean => !NOT_STORABLE.test(value);

/**
 * One emoji and nothing else: a pictograph with its optional variation selector and
 * skin-tone modifier, joined by zero-width joiners (family, profession), or a flag
 * (two regional indicators), or a keycap. Unicode emoji only — custom emoji are a
 * permanent non-goal (D-4) — and a reaction is one of them, so a string of text
 * cannot be stored in the column that holds it. Whether the glyph exists on a
 * given platform is the platform's business.
 */
const EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;

FormatRegistry.Set('uuid', (value) => UUID.test(value));
FormatRegistry.Set('date-time', (value) => DATE_TIME.test(value));
FormatRegistry.Set('email', (value) => EMAIL.test(value));
FormatRegistry.Set('uri', (value) => URI.test(value));
FormatRegistry.Set('message-content', isMessageContent);
/**
 * Something a person can see: a character that is neither white space nor an invisible format
 * character (a zero-width space, a joiner, a byte order mark). A name of only those passed, and a
 * sidebar showed a workspace with no name (#507 review).
 */
const VISIBLE = /[^\s\p{Cf}]/u;

FormatRegistry.Set('name', (value) => !FORBIDDEN_IN_NAME.test(value) && VISIBLE.test(value));
FormatRegistry.Set('plain-text', isPlainText);
/**
 * A link a person will open (D-137 §3): nothing a name may not hold, and no other format character
 * either — an invisible one makes the link shown differ from the link followed.
 */
FormatRegistry.Set('link', (value) => !FORBIDDEN_IN_NAME.test(value) && !/\p{Cf}/u.test(value));
FormatRegistry.Set('emoji', (value) => EMOJI.test(value));

export const REGISTERED_FORMATS = [
  'uuid',
  'date-time',
  'email',
  'uri',
  'message-content',
  'name',
  'plain-text',
  'link',
  'emoji',
] as const;
