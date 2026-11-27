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
  /**
   * Serve over TLS with this certificate. Only a harness uses it: WebKit on Linux does not send a `Secure`
   * cookie to `http://localhost` (macOS WebKit, Chromium and Firefox do), so the session cookie the
   * browser tests carry would never reach the API there; over `https` it does.
   */
  readonly tls?: { readonly cert: string; readonly key: string };
  /**
   * How long the API has to begin answering one request before the front says it did not (`UPSTREAM_MS` where absent).
   * A test of the front gives a short one.
   */
  readonly upstreamMs?: number;
  /** Records document handling in the WebKit harness. */
  readonly documentLog?: (event: DocumentEvent) => void;
}

interface DocumentReceipt {
  readonly id: number;
  readonly pathHash: string;
  readonly port: number | null;
  readonly at: number;
}

type DocumentBodyStage = 'body-started' | 'body-completed' | 'body-cancelled' | 'body-failed';

export type DocumentEvent = DocumentReceipt &
  (
    | { readonly stage: 'received' | 'aborted' | DocumentBodyStage }
    | { readonly stage: 'responding'; readonly status: number }
  );

/**
 * Every page and file comes through the front, so a request the API takes and never answers would leave a browser
 * waiting for its own document until the test's timeout, saying nothing of which request it was. This is far past
 * anything the API does in a test (its slowest answer is a second or two), and short of the thirty seconds a
 * navigation is given.
 */
const UPSTREAM_MS = 15_000;

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

const CONNECTION_FIELDS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const;

/** Keep connection controls on their own hop (RFC 9110 §7.6.1). */
const forwardedHeaders = (source: Headers): Headers => {
  const headers = new Headers(source);
  const options = new Set(
    source
      .get('connection')
      ?.split(',')
      .map((name) => name.trim().toLowerCase()),
  );
  for (const name of [...headers.keys()]) {
    if (options.has(name)) headers.delete(name);
  }
  for (const name of CONNECTION_FIELDS) headers.delete(name);
  return headers;
};

const proxy = async (
  request: Request,
  url: URL,
  api: string,
  upstreamMs: number,
): Promise<Response> => {
  const headers = forwardedHeaders(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  // Asked for plain bytes so the answer can be passed on as it came, headers and all.
  headers.set('accept-encoding', 'identity');
  // Read before the call, so a client that went away is not blamed on the API.
  const body =
    request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : null;
  let upstream: Response;
  // Until the API begins to answer, not until the answer ends: a download or a stream may take as long as it takes.
  const giveUp = new AbortController();
  const timer = setTimeout(() => {
    giveUp.abort();
  }, upstreamMs);
  try {
    upstream = await fetch(`${api}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: giveUp.signal,
      ...(body === null ? {} : { body }),
    });
  } catch (error) {
    if (giveUp.signal.aborted) {
      process.stderr.write(
        `demo proxy: ${request.method} ${url.pathname} got no answer from the API in ${String(upstreamMs)} ms\n`,
      );
      return new Response('The API did not answer in time.', { status: 504 });
    }
    // Every page and file comes through here: a 502 with no cause would leave a browser test
    // failing on a missing chunk with nothing to say why.
    process.stderr.write(
      `demo proxy: ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return new Response('The API is not answering.', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
  const answer = forwardedHeaders(upstream.headers);
  answer.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers: answer });
};

/** Record when the proxy starts and finishes reading the document stream. */
const traceDocumentBody = (
  response: Response,
  note: (stage: DocumentBodyStage) => void,
): Response => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let started = false;
  let terminal = false;
  const body = new ReadableStream(
    {
      pull: async (controller): Promise<void> => {
        try {
          const part = await reader.read();
          if (terminal) return;
          if (part.done) {
            terminal = true;
            note('body-completed');
            controller.close();
            return;
          }
          if (!started) {
            started = true;
            note('body-started');
          }
          controller.enqueue(part.value);
        } catch (error) {
          if (terminal) return;
          terminal = true;
          note('body-failed');
          controller.error(error);
        }
      },
      cancel: async (reason: unknown): Promise<void> => {
        if (terminal) return;
        terminal = true;
        note('body-cancelled');
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
  const documentLog = options.documentLog;
  let documentId = 0;
  return Bun.serve<SocketData>({
    // `/__demo/login` hands a signed-in session to whoever asks. Bun's default is every
    // interface, which on a café network is everybody; loopback is the whole audience (H-API 9).
    hostname: '127.0.0.1',
    port: options.port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
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
        case 'api': {
          const upstreamMs = options.upstreamMs ?? UPSTREAM_MS;
          if (documentLog === undefined || request.headers.get('sec-fetch-dest') !== 'document') {
            return await proxy(request, url, options.api, upstreamMs);
          }
          const receipt = {
            id: ++documentId,
            // Paths can carry invitation and recovery tokens. Compare the trace's pathname by hash.
            pathHash: new Bun.CryptoHasher('sha256').update(url.pathname).digest('hex'),
            port: server.requestIP(request)?.port ?? null,
          };
          const aborted = (): void => {
            documentLog({ ...receipt, stage: 'aborted', at: Date.now() });
          };
          const signal = request.signal;
          documentLog({ ...receipt, stage: 'received', at: Date.now() });
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
          try {
            const response = await proxy(request, url, options.api, upstreamMs);
            documentLog({
              ...receipt,
              stage: 'responding',
              at: Date.now(),
              status: response.status,
            });
            return traceDocumentBody(response, (stage) => {
              documentLog({ ...receipt, stage, at: Date.now() });
            });
          } finally {
            signal.removeEventListener('abort', aborted);
          }
        }
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
