/**
 * The one rule for the address of an OpenID Connect provider — its issuer (D-200 §2) — apart from the
 * sign-in code so that the configuration, the server's settings and the probe can all ask it without
 * loading the provider.
 *
 * An issuer is an identifier before it is an address, and **the id_token's `iss` must equal it byte for
 * byte** (OpenID Connect Core §3.1.3.7): so it is kept exactly as written and never normalised. What is
 * refused is what no provider has: a query or a fragment (Discovery §2), credentials in it, and any
 * scheme but `https` — or `http` to this machine, for a provider run beside the server to try it.
 */

/** The hosts `http://` may name: this machine's own, where nothing crosses a network. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `url` is one a provider's endpoint may be fetched from: `https`, or `http` to this machine. */
export const isFetchableAddress = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));

/** Why `issuer` is not one this server will sign in through, or nothing. The reason never quotes the value. */
export const oidcIssuerProblem = (issuer: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'not an absolute address';
  }
  if (!isFetchableAddress(url)) return 'must be https://, or http:// to this machine';
  // A trailing `?` or `#` is empty to the parser and still is not the issuer the provider puts in a token.
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    issuer.includes('?') ||
    issuer.includes('#')
  ) {
    return 'an address without credentials, query or fragment';
  }
  return undefined;
};

/** Where a provider publishes its metadata: the issuer with `/.well-known/openid-configuration` appended (Discovery §4). */
export const oidcDiscoveryAddress = (issuer: string): string =>
  `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

/** The button's name: a short line of visible characters, no control or format characters (D-200 §7). */
const VISIBLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

/** Why `name` is not one a button may carry, or nothing. */
export const oidcNameProblem = (name: string, max: number): string | undefined => {
  if (name === '' || name.trim() !== name) return 'a name with no space around it';
  if (Array.from(name).length > max) return `at most ${String(max)} characters`;
  if (!VISIBLE.test(name)) return 'a name of visible characters';
  return undefined;
};
