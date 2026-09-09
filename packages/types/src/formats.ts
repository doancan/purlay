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

FormatRegistry.Set('uuid', (value) => UUID.test(value));
FormatRegistry.Set('date-time', (value) => DATE_TIME.test(value));
FormatRegistry.Set('email', (value) => EMAIL.test(value));
FormatRegistry.Set('uri', (value) => URI.test(value));

export const REGISTERED_FORMATS = ['uuid', 'date-time', 'email', 'uri'] as const;
