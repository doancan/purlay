/**
 * Who a request is from: for a rate limit's key and for `sessions.ip_address`.
 *
 * **`X-Forwarded-For` is a client-written header.** Anyone can send one, and a
 * limit keyed on it hands every attacker a fresh budget per request. So it is
 * read only when `TRUST_PROXY` says a proxy we run sits in front, and then only
 * the **last** entry — the one that proxy appended, naming the peer it saw. The
 * entries before it were written by whoever the proxy was talking to. This is
 * exactly one trusted hop; a chain of proxies is a deployment this product does
 * not claim (`CONFIG.md`). Without `TRUST_PROXY` the socket's peer address is
 * the client, and the header is ignored.
 */
import { isIP } from 'node:net';
import { unmappedAddress } from '../../platform/client-key';

/** The part of the server this needs: the framework's `server`, which is `null` under `handle`. */
export interface PeerSource {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
}

/** The socket's remote address — the one thing the request itself cannot say. */
export const peerOf = (server: PeerSource | null, request: Request): string | undefined =>
  server?.requestIP(request)?.address;

const valid = (candidate: string | undefined): string | undefined => {
  if (candidate === undefined) return undefined;
  const address = unmappedAddress(candidate.trim());
  return isIP(address) === 0 ? undefined : address;
};

/**
 * The client's address, or `undefined` when none can be established.
 *
 * Never a guess: a header that is not an address is not used, and a trusted
 * proxy that sent nothing usable falls back to the peer it is, not to an earlier
 * entry a client could have written.
 */
export const clientAddress = (
  peer: string | undefined,
  headers: Headers,
  trustProxy: boolean,
): string | undefined => {
  const forwardedFor = headers.get('x-forwarded-for');
  if (trustProxy && forwardedFor !== null) {
    const forwarded = valid(forwardedFor.split(',').at(-1));
    if (forwarded !== undefined) return forwarded;
  }
  return valid(peer);
};
