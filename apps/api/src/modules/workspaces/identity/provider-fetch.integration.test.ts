/** Real HTTP/TLS connections exercise the public-address lookup, complete-body deadline and secret boundary. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import { aSelfSignedCertificate } from '../../../testing/certificate';
import { checkingLookup, type Resolver } from '../../images/fetch-external';
import type { OidcFetch } from '../../auth/oidc';
import {
  COMPANY_PROVIDER_REPLY_MAX_BYTES,
  CompanyProviderTransportError,
  companyProviderFetch,
} from './provider-fetch';

let port = 0;
let received = 0;
let answer: (request: http.IncomingMessage, response: http.ServerResponse) => void = (
  _request,
  response,
) => {
  response.end('{}');
};
const server = http.createServer((request, response) => {
  received++;
  answer(request, response);
});
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test listener');
  port = address.port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const local: Resolver = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
// Like the existing external transport tests, plain HTTP and an explicit local address policy belong only to this fixture.
const fetchLocal = (): OidcFetch =>
  companyProviderFetch({
    transport: http,
    port,
    timeoutMs: 1_000,
    lookup: checkingLookup(local, (address) => address === '127.0.0.1'),
  });
const init = (): Parameters<OidcFetch>[1] => ({
  headers: { accept: 'application/json' },
  redirect: 'manual',
  signal: AbortSignal.timeout(2_000),
});
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'unexpected success';
  } catch (error) {
    return error instanceof CompanyProviderTransportError ? error.reason : String(error);
  }
};

describe('integration: company provider transport', () => {
  test('a transport that cannot create a request becomes a safe bounded failure', async () => {
    const fetch = companyProviderFetch({
      transport: {
        request: () => {
          throw new Error('transport details must stay private');
        },
      },
    });
    expect(await refusal(async () => await fetch('https://idp.example/token', init()))).toBe(
      'unavailable',
    );
  });

  test('a provider disconnecting before its declared body ends cannot return a partial identity', async () => {
    answer = (_request, response): void => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('{"partial":');
      response.end();
    };
    expect(await refusal(async () => await fetchLocal()('https://idp.example/token', init()))).toBe(
      'unavailable',
    );
  });

  test('GET/POST use the checked host, retain the path and send only explicit verifier headers', async () => {
    const requests: {
      readonly method: string;
      readonly path: string;
      readonly headers: http.IncomingHttpHeaders;
      readonly body: string;
    }[] = [];
    answer = (request, response): void => {
      const chunks: Uint8Array[] = [];
      request.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"verified":true}');
      });
    };
    const get = fetchLocal();
    expect(await (await get('https://idp.example/metadata?tenant=one', init())).json()).toEqual({
      verified: true,
    });
    const credentials = 'grant_type=authorization_code&client_secret=fixture-secret';
    await get('https://idp.example/token', {
      ...init(),
      method: 'POST',
      body: credentials,
      headers: {
        authorization: 'Basic fixture-only',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'private-session',
        host: 'attacker.example',
        referer: 'https://purlay.app/private',
      },
    });
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(requests[0]?.path).toBe('/metadata?tenant=one');
    const post = requests[1];
    expect(post?.body).toBe(credentials);
    expect(post?.headers.authorization).toBe('Basic fixture-only');
    expect(post?.headers.host).toBe(`idp.example:${String(port)}`);
    expect(post?.headers.cookie).toBeUndefined();
    expect(post?.headers.referer).toBeUndefined();
    expect(post?.headers['accept-encoding']).toBe('identity');
    expect(post?.headers['content-length']).toBe(String(Buffer.byteLength(credentials)));
  });

  test('literal IPs, local HTTP, credentials and fragments are refused before DNS or any request', async () => {
    const before = received;
    const get = fetchLocal();
    for (const address of [
      'https://127.0.0.1/token',
      'https://[::1]/token',
      'https://2130706433/token',
      'http://idp.example/token',
      'https://localhost/token',
      'https://idp.localhost/token',
      'https://a:fixture-secret@idp.example/token',
      'https://idp.example/token#fragment',
      'not a URL',
      'https://idp.\nexample/token',
    ]) {
      expect(await refusal(async () => await get(address, init()))).toBe('address');
    }
    expect(received).toBe(before);
  });

  test('the production public-address policy rejects private or mixed DNS without connecting', async () => {
    const before = received;
    for (const addresses of [
      [],
      [{ address: '127.0.0.1', family: 4 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      [{ address: '::1', family: 6 }],
    ]) {
      const get = companyProviderFetch({
        transport: http,
        port,
        lookup: checkingLookup(() => Promise.resolve(addresses)),
      });
      expect(await refusal(async () => await get('https://idp.example/token', init()))).toBe(
        'unavailable',
      );
    }
    expect(received).toBe(before);
  });

  test('each connection resolves afresh; a later rebinding never uses a cached socket', async () => {
    let resolutions = 0;
    const resolve: Resolver = () =>
      Promise.resolve([{ address: ++resolutions === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }]);
    const get = companyProviderFetch({
      transport: http,
      port,
      lookup: checkingLookup(resolve, (address) => address === '127.0.0.1'),
    });
    answer = (_request, response): void => {
      response.end('{}');
    };
    const before = received;
    expect((await get('https://idp.example/keys', init())).status).toBe(200);
    expect(await refusal(async () => await get('https://idp.example/token', init()))).toBe(
      'unavailable',
    );
    expect(resolutions).toBe(2);
    expect(received).toBe(before + 1);
  });

  test('a token redirect never resends credentials or visits its target', async () => {
    const before = received;
    answer = (_request, response): void => {
      response.writeHead(307, { location: `http://127.0.0.1:${String(port)}/stolen` });
      response.end();
    };
    expect(
      await refusal(
        async () =>
          await fetchLocal()('https://idp.example/token', {
            ...init(),
            method: 'POST',
            body: 'client_secret=fixture-secret',
          }),
      ),
    ).toBe('reply');
    expect(received).toBe(before + 1);
  });

  test('declared and streaming bodies stop at the limit, including a provider that never ends', async () => {
    for (const declared of [true, false]) {
      answer = (_request, response): void => {
        if (declared)
          response.setHeader('content-length', String(COMPANY_PROVIDER_REPLY_MAX_BYTES + 1));
        response.write(Buffer.alloc(COMPANY_PROVIDER_REPLY_MAX_BYTES + 1, 97));
      };
      expect(
        await refusal(async () => await fetchLocal()('https://idp.example/keys', init())),
      ).toBe('too-large');
    }
    const bytes = Buffer.alloc(COMPANY_PROVIDER_REPLY_MAX_BYTES, 97);
    answer = (_request, response): void => {
      response.end(bytes);
    };
    expect(
      (await (await fetchLocal()('https://idp.example/keys', init())).arrayBuffer()).byteLength,
    ).toBe(COMPANY_PROVIDER_REPLY_MAX_BYTES);
  });

  test('compressed replies and oversized requests are refused without retaining provider data', async () => {
    answer = (_request, response): void => {
      response.setHeader('content-encoding', 'gzip');
      response.end('fixture-provider-secret');
    };
    expect(await refusal(async () => await fetchLocal()('https://idp.example/keys', init()))).toBe(
      'reply',
    );
    const before = received;
    expect(
      await refusal(
        async () =>
          await fetchLocal()('https://idp.example/token', {
            ...init(),
            method: 'POST',
            body: 'a'.repeat(64 * 1024 + 1),
          }),
      ),
    ).toBe('too-large');
    expect(received).toBe(before);
  });

  test('a stalled body is bounded even when headers already arrived', async () => {
    answer = (_request, response): void => {
      response.writeHead(200);
      response.write('{');
    };
    const get = companyProviderFetch({
      transport: http,
      port,
      timeoutMs: 30,
      lookup: checkingLookup(local, (address) => address === '127.0.0.1'),
    });
    expect(await refusal(async () => await get('https://idp.example/keys', init()))).toBe(
      'timeout',
    );
  });

  test('an aborted request releases a hanging connection and a later request still works', async () => {
    const started = Promise.withResolvers<undefined>();
    answer = (_request, response): void => {
      response.write('{');
      started.resolve(undefined);
    };
    const controller = new AbortController();
    const result = refusal(
      async () =>
        await fetchLocal()('https://idp.example/token', { ...init(), signal: controller.signal }),
    );
    await started.promise;
    controller.abort();
    expect(await result).toBe('aborted');
    expect(
      await refusal(
        async () =>
          await fetchLocal()('https://idp.example/token', { ...init(), signal: controller.signal }),
      ),
    ).toBe('aborted');
    answer = (_request, response): void => {
      response.end('{}');
    };
    expect((await fetchLocal()('https://idp.example/keys', init())).status).toBe(200);
  });

  test('TLS still rejects an untrusted certificate before sending a client secret', async () => {
    let tokenRequests = 0;
    const tls = https.createServer(aSelfSignedCertificate(), (_request, response) => {
      tokenRequests++;
      response.end('{}');
    });
    await new Promise<void>((resolve) => {
      tls.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = tls.address();
      if (address === null || typeof address === 'string') throw new Error('Missing TLS listener');
      const get = companyProviderFetch({
        port: address.port,
        lookup: checkingLookup(local, () => true),
      });
      expect(
        await refusal(
          async () =>
            await get('https://idp.example/token', {
              ...init(),
              method: 'POST',
              body: 'client_secret=fixture-secret',
            }),
        ),
      ).toBe('unavailable');
      expect(tokenRequests).toBe(0);
    } finally {
      tls.closeAllConnections();
      tls.close();
    }
  });
});
