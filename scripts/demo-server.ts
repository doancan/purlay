/**
 * The one origin a browser sees in the demo: the built client, and the API behind it.
 *
 * This is the production shape (D-61) with the smallest possible moving parts — static
 * files with a fallback to `index.html` for client-side routes, and a proxy for
 * `/auth`, `/api`, `/health` and the `/ws` upgrade — so the demo exercises what a
 * deployment does and not what the Vite dev server forgives: the cookie is on one
 * origin, the socket's `Origin` is the page's, and a path the proxy forgot answers with
 * the wrong thing exactly as it would in front of a real server.
 *
 * **`/__demo/login?as=<name>` exists here and nowhere else.** GitHub cannot be reached
 * from a laptop, so the harness hands a browser the genuine session cookie the seed
 * issued. It is a route of this process, which only the demo harness starts; the API has
 * no development sign-in and never will (`ARCHITECTURE.md` §7.1).
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

export interface FrontOptions {
  /** The built client: `apps/web/dist`. */
  readonly dist: string;
  /** The API's origin, `http://localhost:3001`. */
  readonly api: string;
  /** Session tokens by persona name, for `/__demo/login`. */
  readonly sessions: Readonly<Record<string, string>>;
  readonly port: number;
}

/** The paths the API owns. Anything else is the client's. */
const API_PREFIXES = ['/auth', '/api', '/health'] as const;

const COOKIE = '__Host-purlay_session';

export type Route = 'socket' | 'login' | 'api' | 'static';

export const routeOf = (pathname: string): Route => {
  if (pathname === '/ws') return 'socket';
  if (pathname === '/__demo/login') return 'login';
  if (API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return 'api';
  }
  return 'static';
};

/** The file a path means inside `dist`, or null when it would climb out. */
export const fileFor = (dist: string, pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(dist, decoded));
  return candidate === dist || candidate.startsWith(dist + sep) ? candidate : null;
};

/** A file with a hash in its name never changes; everything else is asked about every time. */
const cacheFor = (pathname: string): string =>
  pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';

const serveStatic = (dist: string, pathname: string): Response => {
  const path = fileFor(dist, pathname);
  if (path === null) return new Response('Not found', { status: 404 });
  if (existsSync(path) && statSync(path).isFile()) {
    return new Response(Bun.file(path), { headers: { 'cache-control': cacheFor(pathname) } });
  }
  // A path with an extension is a file that is not there; a path without one is a
  // client route, and the client decides what it means.
  if (/\.[A-Za-z0-9]+$/.test(pathname)) return new Response('Not found', { status: 404 });
  return new Response(Bun.file(join(dist, 'index.html')), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
};

const login = (url: URL, sessions: FrontOptions['sessions']): Response => {
  const who = url.searchParams.get('as') ?? '';
  const token = sessions[who];
  if (token === undefined) {
    return new Response(`No such demo person. Try: ${Object.keys(sessions).join(', ')}`, {
      status: 404,
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      // The attributes the API itself sets (`platform/cookies.ts`): the `__Host-` prefix
      // requires `Secure` and `Path=/`, and `localhost` is a secure context.
      'set-cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    },
  });
};

const HOP_BY_HOP = ['host', 'connection', 'accept-encoding', 'content-length'] as const;

const proxy = async (request: Request, url: URL, api: string): Promise<Response> => {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // Asked for plain bytes so the answer can be passed on as it came, headers and all.
  headers.set('accept-encoding', 'identity');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(`${api}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    });
  } catch {
    return new Response('The API is not answering.', { status: 502 });
  }
  const answer = new Headers(upstream.headers);
  answer.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers: answer });
};

interface SocketData {
  readonly cookie: string;
  readonly origin: string;
  upstream: WebSocket | null;
  readonly queue: (string | Buffer)[];
}

/** Starts the front server. The returned handle's `stop` closes it. */
export const startFront = (options: FrontOptions): ReturnType<typeof Bun.serve<SocketData>> => {
  const wsApi = options.api.replace(/^http/, 'ws');
  return Bun.serve<SocketData>({
    // `/__demo/login` hands a signed-in session to whoever asks. Bun's default is every
    // interface, which on a café network is everybody; loopback is the whole audience (H-API 9).
    hostname: '127.0.0.1',
    port: options.port,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      switch (routeOf(url.pathname)) {
        case 'socket': {
          const data: SocketData = {
            cookie: request.headers.get('cookie') ?? '',
            origin: request.headers.get('origin') ?? '',
            upstream: null,
            queue: [],
          };
          return server.upgrade(request, { data })
            ? undefined
            : new Response('Expected a WebSocket upgrade.', { status: 426 });
        }
        case 'login':
          return login(url, options.sessions);
        case 'api':
          return await proxy(request, url, options.api);
        case 'static':
          return serveStatic(options.dist, url.pathname);
      }
    },
    websocket: {
      // The socket is passed through as it is: the API sees the browser's own cookie
      // and `Origin`, so its upgrade checks (D-39) judge the real thing.
      open: (client) => {
        const upstream = new WebSocket(`${wsApi}/ws`, {
          headers: { cookie: client.data.cookie, origin: client.data.origin },
        } as unknown as string[]);
        client.data.upstream = upstream;
        upstream.addEventListener('open', () => {
          for (const queued of client.data.queue) upstream.send(queued);
          client.data.queue.length = 0;
        });
        upstream.addEventListener('message', (event) => {
          client.send(event.data as string);
        });
        upstream.addEventListener('close', (event) => {
          client.close(event.code === 1005 ? 1000 : event.code);
        });
      },
      message: (client, message) => {
        const upstream = client.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else client.data.queue.push(message);
      },
      close: (client, code) => {
        client.data.upstream?.close(code === 1005 ? 1000 : code);
      },
    },
  });
};
