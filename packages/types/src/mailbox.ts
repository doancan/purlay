/**
 * What is an e-mail address to send to: one mailbox, nothing a mail library would read more out of.
 * One home for the server's sign-in link (D-138 §7) and invitation e-mails (D-179 §5) and for the
 * screen that checks an address as it is typed, so no door accepts a string another would refuse.
 */

/**
 * An address and nothing else: dot-separated atoms before the `@`, dotted labels after it, ASCII only.
 * A looser check let `x<victim@example.com>` and `victim@example.com,x` through — strings a mail library
 * delivers to one mailbox while each is its own to count, and none matches the account holding the
 * mailbox (D-138 §7). A control character can never pass, so nothing typed can make a header.
 *
 * No wider than the library takes either: its `/sign-in/magic-link` checks the address again (zod's
 * `email`), and refuses `%`, `!` and their like, a local part ending in `'`, and a last label that is
 * not two letters or more. What it would refuse is refused here.
 */
const ATOM = "[a-z0-9_'+-]+";
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ADDRESS = new RegExp(`^(?:${ATOM}\\.)*${ATOM}(?<!')@(?:${LABEL}\\.)+[a-z]{2,}$`);

/** The longest an address may be (RFC 5321): the contract's and every field's that takes one. */
export const EMAIL_MAX = 254;

/** The address as it is stored and compared (D-40): trimmed, lower-cased, one mailbox — or nothing. */
export const normalisedMailbox = (typed: string): string | undefined => {
  const address = typed.trim().toLowerCase();
  return address.length <= EMAIL_MAX && ADDRESS.test(address) ? address : undefined;
};
