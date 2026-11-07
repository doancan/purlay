/** On-demand binary reads: no retained bytes, no unbounded arrayBuffer/text read, no trusted size header. */
import { ApiError } from './errors';
import type { FetchPort } from './http';

/** A valid download can be larger than the local reader permits; it is not a server refusal. */
export class BinaryLimitError extends Error {
  constructor() {
    super('The response exceeds the preview byte limit.');
    this.name = 'BinaryLimitError';
  }
}

/** Error JSON has no reason to be a file: an upstream's unbounded error page must not be read whole. */
const ERROR_BYTES_MAX = 16 * 1024;

export const readBinary = async (
  fetchFn: FetchPort,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  refusal: (status: number, text: string) => ApiError,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError('Invalid binary byte limit');
  const interrupted = new ApiError(0, 'NETWORK', 'The binary read was cancelled.');
  if (signal?.aborted === true) throw interrupted;
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    let rejectAbandoned: ((error: Error) => void) | undefined;
    const abandoned = new Promise<never>((_, reject) => {
      rejectAbandoned = reject;
    });
    const abort = (): void => {
      rejectAbandoned?.(interrupted);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
    try {
      return await Promise.race([pending, abandoned]);
    } finally {
      // A document can arrive in many tiny chunks: do not retain a listener or race per old chunk.
      signal?.removeEventListener('abort', abort);
    }
  };
  try {
    const response = await wait(
      fetchFn(path, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-cache',
        headers: { accept: 'application/octet-stream' },
        ...(signal === undefined ? {} : { signal }),
      }).then((answer) => {
        // A transport may finish after its caller gave up. Discard that late body as well.
        if (signal?.aborted === true) {
          void answer.body?.cancel().catch(() => {
            /* The caller already abandoned this body; cleanup must not replace its failure. */
          });
          throw interrupted;
        }
        return answer;
      }),
    );
    const limit = response.ok ? maxBytes : ERROR_BYTES_MAX;
    const reader = response.body?.getReader();
    let result: Uint8Array<ArrayBuffer>;
    try {
      const declared = Number(response.headers.get('content-length'));
      if (declared > limit) throw new BinaryLimitError();
      // Grow bytes, not an array of chunks: chunk count must not become an unbounded second allocation.
      let data = new Uint8Array(Math.min(limit, 64 * 1024));
      let size = 0;
      if (reader !== undefined) {
        for (;;) {
          const next = await wait(reader.read());
          if (next.done) break;
          const end = size + next.value.byteLength;
          if (end > limit) throw new BinaryLimitError();
          if (end > data.byteLength) {
            const grown = new Uint8Array(Math.min(limit, Math.max(end, data.byteLength * 2)));
            grown.set(data);
            data = grown;
          }
          data.set(next.value, size);
          size = end;
        }
      }
      result = size === data.byteLength ? data : data.slice(0, size);
    } catch (error) {
      if (!response.ok && error instanceof BinaryLimitError) throw refusal(response.status, '');
      throw error;
    } finally {
      // Neither a broken transport nor an uncooperative underlying cancellation may hold the UI open.
      if (reader !== undefined) {
        void reader.cancel().catch(() => {
          /* The caller already abandoned this body; cleanup must not replace its failure. */
        });
        reader.releaseLock();
      }
    }
    if (!response.ok) throw refusal(response.status, new TextDecoder().decode(result));
    return result;
  } catch (cause) {
    if (cause instanceof ApiError || cause instanceof BinaryLimitError) throw cause;
    throw new ApiError(0, 'NETWORK', 'The binary answer stopped before it was whole.', {}, cause);
  }
};
