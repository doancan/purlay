/**
 * The one origin a browser sees in the demo: the API, which serves the built client itself
 * (D-61), behind a proxy that adds one route.
 *
 * Everything but that route goes to the API as it came — files, the shell, `/auth`, `/api`,
 * `/health` and the `/ws` upgrade — so the demo and every browser test exercise the
 * production path, under the document's real security policy (D-102), and not a copy of it.
 * The cookie is on one origin, and the socket's `Origin` is the page's.
 *
 * **`/__demo/login?as=<name>` exists here and nowhere else.** GitHub cannot be reached
 * from a laptop, so the harness hands a browser the genuine session cookie the seed
 * issued. It is a route of this process, which only the demo harness starts; the API has
 * no development sign-in and never will (`ARCHITECTURE.md` §7.1).
 */

export interface FrontOptions {
  /** The API's origin, `http://localhost:3001`, started with `CLIENT_DIST`. */
  readonly api: string;
  /** Session tokens by persona name, for `/__demo/login`. */
  readonly sessions: Readonly<Record<string, string>>;
  readonly port: number;
}

const COOKIE = '__Host-purlay_session';

export type Route = 'socket' | 'login' | 'api';

export const routeOf = (pathname: string): Route => {
  if (pathname === '/ws') return 'socket';
  if (pathname === '/__demo/login') return 'login';
  return 'api';
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
  // Read before the call, so a client that went away is not blamed on the API.
  const body =
    request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : null;
  let upstream: Response;
  try {
    upstream = await fetch(`${api}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(body === null ? {} : { body }),
    });
  } catch (error) {
    // Every page and file comes through here: a 502 with no cause would leave a browser test
    // failing on a missing chunk with nothing to say why.
    process.stderr.write(
      `demo proxy: ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

/**
 * A close code that may be put on the wire again. 1005 (none given), 1006 (the connection was
 * lost: never sent, only reported) and anything else outside 1000–1014 / 3000–4999 are what a
 * socket *reports*, and `close()` refuses them — so a browser tab that vanishes would crash the
 * proxy that tried to pass its report on.
 */
export const forwardableCode = (code: number): number =>
  code === 1004 || code === 1005 || code === 1006 || code === 1015 ? 1000 : code;

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
          client.close(forwardableCode(event.code));
        });
      },
      message: (client, message) => {
        const upstream = client.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else client.data.queue.push(message);
      },
      close: (client, code) => {
        client.data.upstream?.close(forwardableCode(code));
      },
    },
  });
};
