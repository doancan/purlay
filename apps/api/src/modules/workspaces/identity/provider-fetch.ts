/** Workspace administrators may name an IdP, but cannot turn discovery or token exchange into a private-network proxy. */
import https from 'node:https';
import type http from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import type { OidcFetch } from '../../auth/oidc';
import { checkingLookup, systemResolver } from '../../images/fetch-external';

export const COMPANY_PROVIDER_REPLY_MAX_BYTES = 256 * 1024;
const REQUEST_MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

type TransportFailure = 'address' | 'unavailable' | 'timeout' | 'aborted' | 'reply' | 'too-large';

/** Never includes an address, credential, provider body or raw transport error in an operator's log. */
export class CompanyProviderTransportError extends Error {
  readonly reason: TransportFailure;

  constructor(reason: TransportFailure) {
    super(`Company identity provider request failed: ${reason}`);
    this.name = 'CompanyProviderTransportError';
    this.reason = reason;
  }
}

/** Internal boot/test dependencies only; these are never accepted in a workspace request. */
export interface CompanyProviderTransport {
  readonly lookup?: LookupFunction;
  readonly transport?: Pick<typeof https, 'request'> | Pick<typeof http, 'request'>;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export const companyProviderAddress = (given: string): URL => {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new CompanyProviderTransportError('address');
  }
  // Literal IP connections can skip node's checked DNS lookup entirely.
  if (
    /[\s\p{Cc}\p{Cf}]/u.test(given) ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    given.includes('#') ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost') ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0
  )
    throw new CompanyProviderTransportError('address');
  return url;
};

/** Fresh DNS-pinned TLS for every request, no redirects, with a bound covering DNS through the last body byte. */
export const companyProviderFetch =
  (options: CompanyProviderTransport = {}): OidcFetch =>
  async (given, init) => {
    const url = companyProviderAddress(given);
    if (init.signal.aborted) throw new CompanyProviderTransportError('aborted');
    const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');
    if (body !== undefined && body.byteLength > REQUEST_MAX_BYTES)
      throw new CompanyProviderTransportError('too-large');
    const supplied = new Headers(init.headers);
    // The strict verifier owns these headers. Browser cookies, host overrides and referrers never cross this boundary.
    const headers: Record<string, string> = {
      accept: supplied.get('accept') ?? 'application/json',
      'accept-encoding': 'identity',
      'user-agent': 'Purlay company sign-in',
    };
    for (const name of ['authorization', 'content-type']) {
      const value = supplied.get(name);
      if (value !== null) headers[name] = value;
    }
    if (body !== undefined) headers['content-length'] = String(body.byteLength);

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let request: http.ClientRequest | undefined;
      let incoming: http.IncomingMessage | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        init.signal.removeEventListener('abort', aborted);
        incoming?.destroy();
        request?.destroy();
      };
      const fail = (reason: TransportFailure): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CompanyProviderTransportError(reason));
      };
      const aborted = (): void => {
        fail('aborted');
      };
      const timer = setTimeout(() => {
        fail('timeout');
      }, options.timeoutMs ?? TIMEOUT_MS);
      init.signal.addEventListener('abort', aborted, { once: true });
      if (init.signal.aborted) {
        fail('aborted');
        return;
      }
      try {
        request = (options.transport ?? https).request(
          {
            host: url.hostname,
            port: options.port ?? (url.port === '' ? 443 : Number(url.port)),
            path: `${url.pathname}${url.search}`,
            method: init.method ?? 'GET',
            headers,
            lookup: options.lookup ?? checkingLookup(systemResolver),
            agent: false,
          },
          (response) => {
            incoming = response;
            response.on('error', () => {
              fail('unavailable');
            });
            response.on('aborted', () => {
              fail('unavailable');
            });
            if (settled) {
              response.destroy();
              return;
            }
            const status = response.statusCode ?? 0;
            // A redirect never resends client credentials, even to another public endpoint.
            if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
              fail('reply');
              return;
            }
            const encoding = (response.headers['content-encoding'] ?? 'identity')
              .trim()
              .toLowerCase();
            if (encoding !== 'identity' && encoding !== '') {
              fail('reply');
              return;
            }
            const declared = Number(response.headers['content-length'] ?? Number.NaN);
            if (Number.isFinite(declared) && declared > COMPANY_PROVIDER_REPLY_MAX_BYTES) {
              fail('too-large');
              return;
            }
            const chunks: Uint8Array[] = [];
            let length = 0;
            response.on('data', (chunk: Uint8Array) => {
              if (settled) return;
              length += chunk.byteLength;
              if (length > COMPANY_PROVIDER_REPLY_MAX_BYTES) {
                fail('too-large');
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(
                new Response(
                  status === 204 || status === 205 ? null : Buffer.concat(chunks, length),
                  {
                    status,
                    headers: {
                      'content-type': response.headers['content-type'] ?? 'application/json',
                    },
                  },
                ),
              );
            });
          },
        );
        request.on('error', () => {
          fail('unavailable');
        });
        request.end(body);
      } catch {
        fail('unavailable');
      }
    });
  };
