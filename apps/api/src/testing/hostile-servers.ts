/**
 * Servers that answer an HTTP client the way nobody should: one that redirects every request to a second
 * server which records what it was sent, and one that answers with more bytes than any reply needs,
 * counting what it managed to hand the socket. For a client of GitHub — the setup's probe, a sign-in —
 * to show it follows no redirect with a secret in hand, and reads no reply without a bound. Test-only.
 */

/** A request as the receiving server saw it. */
interface Received {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

export interface Redirecting {
  /** The base a client is pointed at: every path under it answers a redirect to `elsewhere`. */
  readonly url: string;
  /** What the server redirected to received: nothing, unless a client followed. */
  readonly elsewhere: Received[];
  readonly stop: () => void;
}

/**
 * Every request answered `status` with a `Location` on another origin (another port), whose server
 * answers what a GitHub would — `bad_verification_code`, an identity — so a client that followed
 * would believe it.
 */
export const aRedirectingServer = (status: 301 | 302 | 307 | 308 = 307): Redirecting => {
  const elsewhere: Received[] = [];
  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      elsewhere.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      });
      return Response.json({ error: 'bad_verification_code', access_token: 'gho_elsewhere' });
    },
  });
  const front = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) =>
      new Response(null, {
        status,
        headers: {
          location: `http://localhost:${String(other.port)}${new URL(request.url).pathname}`,
        },
      }),
  });
  return {
    url: `http://127.0.0.1:${String(front.port)}`,
    elsewhere,
    stop: (): void => {
      void front.stop(true);
      void other.stop(true);
    },
  };
};

export interface Flooding {
  readonly url: string;
  /** How many bytes the server has handed its socket so far. */
  readonly written: () => number;
  readonly stop: () => void;
}

/**
 * How far a flooding server may get before a client that stops reading has let go: the floods are 300 MiB,
 * and a client that read on to the end would leave `written()` at all of it. What is measured is what the
 * server handed its socket by the time the close reached it, and that includes the kernel's socket buffers
 * on both ends — Linux grows them under load to `tcp_wmem` (4 MiB) plus `tcp_rmem` (6 MiB) — so a bound
 * of 4 MiB held only on an idle machine (CI measured 4259840 bytes, D-228). Set a decade below the flood
 * rather than a hair above what a quiet machine writes; it still fails for a client that keeps reading.
 */
export const STOPPED_WELL_BEFORE_THE_FLOOD_ENDS = 32 * 1024 * 1024;

const CHUNK = new Uint8Array(64 * 1024).fill(0x61);

/**
 * Every request answered `200` with `total` bytes of `a`, made as the client reads them — so what is
 * written is what the client asked for, plus what the sockets buffer. With `declared`, the length is
 * said up front in `Content-Length`.
 */
export const aFloodingServer = (
  total: number,
  { declared = false }: { readonly declared?: boolean } = {},
): Flooding => {
  let written = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      let left = total;
      const body = new ReadableStream<Uint8Array>({
        pull: (controller): void => {
          if (left <= 0) {
            controller.close();
            return;
          }
          const chunk = left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left);
          left -= chunk.length;
          written += chunk.length;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'application/json',
          ...(declared ? { 'content-length': String(total) } : {}),
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    written: () => written,
    stop: (): void => {
      void server.stop(true);
    },
  };
};
