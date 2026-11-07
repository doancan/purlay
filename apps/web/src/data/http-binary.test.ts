import { describe, expect, test } from 'bun:test';
import { createHttp } from './http';
import { ApiError } from './errors';
import { BinaryLimitError } from './http-binary';

const failure = async (pending: Promise<unknown>): Promise<unknown> =>
  await pending.then(
    () => null,
    (error: unknown) => error,
  );

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values);

describe('a bounded binary read', () => {
  test('reads exact bytes with the session, revalidation and caller cancellation', async () => {
    let request: RequestInit | undefined;
    let path: string | undefined;
    const signal = new AbortController().signal;
    const client = createHttp((url, options) => {
      path = url;
      request = options;
      return Promise.resolve(new Response(bytes(0, 255, 3)));
    });
    expect(await client.bytes('/api/file', 3, { signal })).toEqual(bytes(0, 255, 3));
    expect(path).toBe('/api/file');
    expect(request).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-cache',
      headers: { accept: 'application/octet-stream' },
      signal,
    });
  });

  test('counts all chunks rather than trusting a missing, low or malformed size header', async () => {
    for (const declared of [null, '1', 'invalid']) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes(1, 2));
          controller.enqueue(bytes(3, 4));
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const client = createHttp(() =>
        Promise.resolve(
          new Response(stream, {
            headers: declared === null ? {} : { 'content-length': declared },
          }),
        ),
      );
      expect(await failure(client.bytes('/file', 3))).toBeInstanceOf(BinaryLimitError);
      expect(cancelled).toBe(true);
    }
  });

  test('rejects an oversized declared body without reading it or waiting for cancellation', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel(): Promise<void> {
        cancelled = true;
        return new Promise(() => {
          /* Deliberately unresolved: cancellation must not await this transport. */
        });
      },
    });
    const client = createHttp(() =>
      Promise.resolve(new Response(stream, { headers: { 'content-length': '4' } })),
    );
    expect(await failure(client.bytes('/file', 3))).toBeInstanceOf(BinaryLimitError);
    expect(cancelled).toBe(true);
  });

  test('a failed cancellation preserves the original byte-limit refusal', async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel(): Promise<void> {
        return Promise.reject(new Error('cleanup failed'));
      },
    });
    const client = createHttp(() =>
      Promise.resolve(new Response(stream, { headers: { 'content-length': '4' } })),
    );
    expect(await failure(client.bytes('/file', 3))).toBeInstanceOf(BinaryLimitError);
  });

  test('joins multiple chunks, accepts the exact bound, and preserves empty responses', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes(1));
        controller.enqueue(bytes(2, 3));
        controller.close();
      },
    });
    expect(await createHttp(() => Promise.resolve(new Response(stream))).bytes('/file', 3)).toEqual(
      bytes(1, 2, 3),
    );
    expect(await createHttp(() => Promise.resolve(new Response(null))).bytes('/file', 3)).toEqual(
      bytes(),
    );
  });

  test('grows across the staging capacity and returns only the received bytes', async () => {
    const first = new Uint8Array(65_536).fill(4);
    const second = new Uint8Array(70_000).fill(9);
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    const result = await createHttp(() => Promise.resolve(new Response(stream))).bytes(
      '/file',
      200_000,
    );
    expect(result.byteLength).toBe(first.length + second.length);
    expect(result[65_535]).toBe(4);
    expect(result[65_536]).toBe(9);
    expect(result[result.length - 1]).toBe(9);
  });

  test('preserves typed authority refusals before applying the successful file size bound', async () => {
    for (const [status, code] of [
      [401, 'UNAUTHENTICATED'],
      [404, 'ATTACHMENT_NOT_FOUND'],
    ] as const) {
      const client = createHttp(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code, message: 'gone' } }), { status }),
        ),
      );
      expect(await failure(client.bytes('/file', 1))).toMatchObject({ status, code });
    }
  });

  test('does not consume an unbounded failure body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(70_000));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const client = createHttp(() => Promise.resolve(new Response(stream, { status: 502 })));
    expect(await failure(client.bytes('/file', 3))).toMatchObject({ status: 502, code: 'NETWORK' });
    expect(cancelled).toBe(true);
  });

  test('aborts a pending chunk read even when the stream cancellation never resolves', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          started?.();
        },
        cancel(): Promise<void> {
          cancelled = true;
          return new Promise(() => {
            /* Deliberately unresolved: cancellation must not await this transport. */
          });
        },
      },
      { highWaterMark: 0 },
    );
    const result = createHttp(() => Promise.resolve(new Response(stream))).bytes('/file', 3, {
      signal: controller.signal,
    });
    await reading;
    controller.abort();
    expect(await failure(result)).toMatchObject({ code: 'NETWORK' });
    expect(cancelled).toBe(true);
  });

  test('does not fetch an already abandoned read and bounds an unanswered fetch by its caller signal', async () => {
    let calls = 0;
    let started: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = createHttp(() => {
      calls += 1;
      started?.();
      return new Promise(() => {
        /* Deliberately unresolved: cancellation must not await this transport. */
      });
    });
    const before = new AbortController();
    before.abort();
    expect(await failure(client.bytes('/file', 3, { signal: before.signal }))).toMatchObject({
      code: 'NETWORK',
    });
    expect(calls).toBe(0);
    const during = new AbortController();
    const result = client.bytes('/file', 3, { signal: during.signal });
    await fetched;
    // The read has started: this assertion would fail if cancellation won before fetch.
    expect(calls).toBe(1);
    during.abort();
    expect(await failure(result)).toMatchObject({ code: 'NETWORK' });
  });

  test('discards a late transport response even when its cancellation fails', async () => {
    let answer: ((response: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = createHttp(() => {
      started?.();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const controller = new AbortController();
    const result = client.bytes('/file', 3, { signal: controller.signal });
    await fetched;
    controller.abort();
    expect(await failure(result)).toMatchObject({ code: 'NETWORK' });
    let discarded: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      discarded = resolve;
    });
    answer?.(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel(): Promise<void> {
            discarded?.();
            return Promise.reject(new Error('late cleanup failed'));
          },
        }),
      ),
    );
    await cancelled;
  });

  test('refuses an invalid local bound before contacting the server', async () => {
    let calls = 0;
    const client = createHttp(() => {
      calls += 1;
      return Promise.resolve(new Response(null));
    });
    for (const limit of [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(await failure(client.bytes('/file', limit))).toBeInstanceOf(RangeError);
    }
    expect(calls).toBe(0);
  });

  test('a broken transport or body is a network failure and never returns a prefix', async () => {
    const offline = createHttp(() => Promise.reject(new Error('offline')));
    expect(await failure(offline.bytes('/file', 3))).toBeInstanceOf(ApiError);
    const broken = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes(1));
        controller.error(new Error('lost body'));
      },
    });
    expect(
      await failure(createHttp(() => Promise.resolve(new Response(broken))).bytes('/file', 3)),
    ).toMatchObject({ code: 'NETWORK' });
  });
});
