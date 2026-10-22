/**
 * A reply from another service, read with a bound: a client of GitHub — a sign-in, the setup's probe —
 * needs a few hundred bytes of JSON, and a service that answers with a stream that never ends would
 * otherwise be read into memory whole (measured in review: a 300 MB reply grew the process by 386 MB).
 *
 * A `Content-Length` past the bound is refused before a byte is read; otherwise the body is read
 * chunk by chunk and the stream cancelled — the connection let go — as soon as the bound is passed.
 */

/** The body as text, or that it was longer than the bound. */
export type CappedBody = { readonly text: string } | { readonly tooLarge: true };

export const readCapped = async (response: Response, limit: number): Promise<CappedBody> => {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return { tooLarge: true };
  }
  if (response.body === null) return { text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const read = (await reader.read()) as { readonly done: boolean; readonly value?: unknown };
    if (read.done) break;
    const value = read.value instanceof Uint8Array ? read.value : new Uint8Array(0);
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
};
