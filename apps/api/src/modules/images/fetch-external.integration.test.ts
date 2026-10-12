/**
 * Fetching an external image (#110, `docs/spikes/image-proxy.md`), against a local server: the address
 * connected to is the one the checking lookup answered, on every request — a kept-alive socket would
 * skip it — and a redirect, a body past the cap or a server too slow is a failure with its reason.
 *
 * The local server is plain HTTP on 127.0.0.1, which production refuses twice over (HTTPS only, public
 * addresses only); here the transport and the address policy are the test's, so what is under test is
 * the rest: the lookup's use, the cap, the clock, the redirect.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
  checkingLookup,
  fetchExternal,
  systemResolver,
  type FetchOptions,
  type Resolver,
} from './fetch-external';

let port = 0;
const served: string[] = [];
let respond: (path: string, res: http.ServerResponse) => void = (_path, res) => {
  res.end('ok');
};
const server = http.createServer((req, res) => {
  served.push(req.url ?? '');
  respond(req.url ?? '', res);
});
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
});

const toLocal: Resolver = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
const anywhere = (): boolean => true;
const options = (
  resolve: Resolver = toLocal,
  allowed: (address: string) => boolean = anywhere,
): FetchOptions => ({
  lookup: checkingLookup(resolve, allowed),
  transport: http,
  port,
  timeoutMs: 1_000,
  maxBytes: 64,
});

describe('integration: fetching an external image', () => {
  test('connects where the lookup said, and answers the body', async () => {
    respond = (_path, res): void => {
      res.end('pixels');
    };
    const result = await fetchExternal(new URL('https://images.example/a.png?x=1'), options());
    expect(result.kind === 'bytes' ? new TextDecoder().decode(result.bytes) : result).toBe(
      'pixels',
    );
    expect(served.at(-1)).toBe('/a.png?x=1');
  });

  test('asks the lookup again on every request: a second answer it refuses is refused', async () => {
    respond = (_path, res): void => {
      res.end('pixels');
    };
    let calls = 0;
    const changing: Resolver = () => {
      calls += 1;
      return Promise.resolve([{ address: calls === 1 ? '127.0.0.1' : '10.0.0.7', family: 4 }]);
    };
    const allowed = (address: string): boolean => address === '127.0.0.1';
    expect(
      (await fetchExternal(new URL('https://images.example/1'), options(changing, allowed))).kind,
    ).toBe('bytes');
    expect(
      await fetchExternal(new URL('https://images.example/2'), options(changing, allowed)),
    ).toEqual({
      kind: 'failed',
      reason: 'refused an address that is not public',
    });
  });

  test('a redirect is not followed', async () => {
    respond = (_path, res): void => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    };
    served.length = 0;
    expect(await fetchExternal(new URL('https://images.example/moved'), options())).toEqual({
      kind: 'failed',
      reason: 'answered 302',
    });
    expect(served).toEqual(['/moved']);
  });

  test('a body past the cap is a failure, not a truncated image', async () => {
    respond = (_path, res): void => {
      res.end('x'.repeat(65));
    };
    expect(await fetchExternal(new URL('https://images.example/big'), options())).toEqual({
      kind: 'failed',
      reason: 'larger than 64 bytes',
    });
  });

  test('a server too slow to answer is a failure within the time given', async () => {
    respond = (): void => undefined;
    const started = performance.now();
    expect(await fetchExternal(new URL('https://images.example/slow'), options())).toEqual({
      kind: 'failed',
      reason: 'took longer than 1000 ms',
    });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test('a name that resolves to nothing, or fails to resolve, is a failure', async () => {
    expect(
      await fetchExternal(
        new URL('https://images.example/'),
        options(() => Promise.resolve([])),
      ),
    ).toEqual({
      kind: 'failed',
      reason: 'refused an address that is not public',
    });
    const failing: Resolver = () => Promise.reject(new Error('ENOTFOUND'));
    expect((await fetchExternal(new URL('https://images.example/'), options(failing))).kind).toBe(
      'failed',
    );
  });

  test('with the system’s resolver and the real policy, a local name is refused before connecting', async () => {
    served.length = 0;
    const result = await fetchExternal(new URL('https://localhost/'), {
      ...options(),
      lookup: checkingLookup(systemResolver),
    });
    expect(result).toEqual({ kind: 'failed', reason: 'refused an address that is not public' });
    expect(served).toEqual([]);
  });

  test('a body cut off half way is a failure, not part of an image', async () => {
    respond = (_path, res): void => {
      res.writeHead(200, { 'content-length': '50' });
      res.write('half');
      setTimeout(() => {
        res.socket?.destroy();
      }, 20);
    };
    expect((await fetchExternal(new URL('https://images.example/cut'), options())).kind).toBe(
      'failed',
    );
  });

  test('a name public on one record and private on another is refused whole, before connecting', async () => {
    served.length = 0;
    const mixed: Resolver = () =>
      Promise.resolve([
        { address: '140.82.112.3', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    const result = await fetchExternal(new URL('https://images.example/m'), {
      ...options(),
      lookup: checkingLookup(mixed),
    });
    expect(result).toEqual({ kind: 'failed', reason: 'refused an address that is not public' });
    expect(served).toEqual([]);
  });
});
