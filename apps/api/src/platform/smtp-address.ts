/**
 * The one rule for an SMTP address (D-138 §6, D-179 §6), apart from the mail transport so that the
 * configuration can ask it without loading one.
 */
/**
 * Why a transport could not be built from this address, or nothing: the one rule for an SMTP address,
 * asked by the configuration and by the server's settings before one is stored (D-179 §6), so a value
 * that would stop every start is refused before it is kept. The reason names the rule, never the value.
 *
 * Parsed as the transport parses it: `smtp://` or `smtps://`, a host, and credentials either both or
 * neither, each a valid escape. A `#`, `/` or `?` in a password ends the authority where the URL
 * parser sees it, so what is left is refused as a path, query or fragment — write them `%23`, `%2F`,
 * `%3F`.
 */
export const smtpUrlProblem = (address: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'not an smtp:// or smtps:// address (a `#`, `/` or `?` in a password is written %23, %2F, %3F)';
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    return 'not an smtp:// or smtps:// address';
  }
  if (url.hostname === '') return 'the address needs a host';
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return 'an address with no path, query or fragment (a `#`, `/` or `?` in a password is written %23, %2F, %3F)';
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return 'the user or the password holds a `%` that is not an escape (write it %25)';
  }
  if ((url.username === '') !== (url.password === '')) {
    return 'a user and password together, or neither';
  }
  return undefined;
};
