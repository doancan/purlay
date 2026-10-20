/**
 * The one place a response is believed: what it accepts, what it refuses, and the
 * shape of every failure. A fake `fetch` answers; nothing here touches a network.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { ApiError, isApiError, isTransient } from './errors';
import { WRITE_DEADLINE_MS, createHttp, type Http, type UploadRequest } from './http';
import { fakeSchedule } from '../testing/fakes';

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

const Thing = Type.Object({ id: Type.String() });

interface Seen {
  url: string;
  init: RequestInit;
}

const http = (respond: () => Response | Promise<Response>): { client: Http; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { client: createHttp(fetchFn), seen };
};

describe('a request', () => {
  test('is same-origin with cookies, asks for JSON, and leaves out what is undefined', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('GET', '/api/things', Thing, {
      query: { before: 'x', after: undefined, limit: 5 },
    });
    expect(seen[0]?.url).toBe('/api/things?before=x&limit=5');
    expect(seen[0]?.init.credentials).toBe('same-origin');
    expect(seen[0]?.init.headers).toEqual({ accept: 'application/json' });
    expect(seen[0]?.init.body).toBeUndefined();
  });

  test('with no query at all, or only undefined ones, has no question mark', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('GET', '/api/things', Thing);
    await client.request('GET', '/api/things', Thing, { query: { a: undefined } });
    expect(seen.map((s) => s.url)).toEqual(['/api/things', '/api/things']);
  });

  test('a body is JSON, and says so', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('POST', '/api/things', Thing, { body: { name: 'x' } });
    expect(seen[0]?.init.body).toBe('{"name":"x"}');
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  test('raw bytes go as they are, said to be octet-stream, never as JSON (D-109 §3)', async () => {
    const { client, seen } = http(() => answer(201, { id: 'a' }));
    const bytes = new Blob([new Uint8Array([1, 2, 3])]);
    await client.request('POST', '/api/up', Thing, { bytes, query: { id: 'x', name: 'a b' } });
    expect(seen[0]?.url).toBe('/api/up?id=x&name=a+b');
    expect(seen[0]?.init.body).toBe(bytes);
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/octet-stream',
    });
  });

  test('carries the abort signal it was given', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    const controller = new AbortController();
    await client.request('GET', '/x', Thing, { signal: controller.signal });
    expect(seen[0]?.init.signal).toBe(controller.signal);
  });
});

describe('a response', () => {
  test('that satisfies the schema is returned', async () => {
    const { client } = http(() => answer(200, { id: 'a' }));
    expect(await client.request('GET', '/x', Thing)).toEqual({ id: 'a' });
  });

  test('that does not is MALFORMED, not partly used', async () => {
    const { client } = http(() => answer(200, { id: 7 }));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe('MALFORMED');
  });

  test('that is not JSON is MALFORMED', async () => {
    const { client } = http(() => answer(200, '<html>'));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe('MALFORMED');
  });
});

describe('a failure', () => {
  test('carries the server code, status and message', async () => {
    const { client } = http(() =>
      answer(404, { error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' } }),
    );
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'CHANNEL_NOT_FOUND',
      message: 'Channel not found.',
      fields: {},
    });
  });

  test('a validation failure names its fields', async () => {
    const { client } = http(() =>
      answer(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: { fields: { name: 'too long' } },
        },
      }),
    );
    const error = await client.send('POST', '/x', { body: {} }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', fields: { name: 'too long' } });
  });

  test.each([
    ['not JSON', '<html>'],
    ['JSON without an error', { oops: true }],
    [
      'an error with a code the contract does not have',
      { error: { code: 'MADE_UP', message: 'x' } },
    ],
    ['a null error', { error: null }],
    ['a non-object', 'null'],
  ])('with a body that is %s is MALFORMED and keeps the status', async (_why, body) => {
    const { client } = http(() => answer(500, body));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500, code: 'MALFORMED' });
  });

  test.each([502, 503, 504])(
    'a %i that is not the API speaking is the server not reached: NETWORK, transient, status kept',
    async (status) => {
      // What a proxy answers while the API is down or restarting: its own page, never ours.
      const { client } = http(() => answer(status, '<html>Bad Gateway</html>'));
      const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
      expect(error).toMatchObject({ status, code: 'NETWORK' });
      expect(isTransient(error)).toBe(true);
    },
  );

  test('a 503 that is the API speaking keeps the API’s own code', async () => {
    const { client } = http(() =>
      answer(503, { error: { code: 'DATABASE_UNAVAILABLE', message: 'later' } }),
    );
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
  });

  test('no response at all is NETWORK, with the cause kept', async () => {
    const cause = new TypeError('Failed to fetch');
    const client = createHttp(() => Promise.reject(cause));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK' });
    expect((error as Error).cause).toBe(cause);
  });

  test('which of them a retry may fix', () => {
    const of = (code: ConstructorParameters<typeof ApiError>[1]): boolean =>
      isTransient(new ApiError(500, code, 'x'));
    expect(
      ['NETWORK', 'DATABASE_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL'].map((c) =>
        of(c as 'NETWORK'),
      ),
    ).toEqual([true, true, true, true]);
    expect(of('CHANNEL_NOT_FOUND')).toBe(false);
    expect(of('MALFORMED')).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
  });
});

describe('send', () => {
  test('does not read the answer, but still reports a failure', async () => {
    const ok = http(() => new Response(null, { status: 204 }));
    await ok.client.send('POST', '/auth/logout');
    expect(ok.seen).toHaveLength(1);
    const bad = http(() => answer(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    const error = await bad.client.send('POST', '/auth/logout').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

/**
 * An upload goes over the one transport that reports a request body's progress (#388): `fetch` says
 * nothing until the answer. Its answer and its failures are read exactly as a request's are.
 */
describe('an upload', () => {
  /** A request the test drives: what was opened and sent, and the server's side of it. */
  class FakeUpload implements UploadRequest {
    public static last: FakeUpload | null = null;
    public opened: [string, string] | null = null;
    public readonly headers: Record<string, string> = {};
    public sent: Blob | null = null;
    public status = 0;
    public responseText = '';
    public readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
      onprogress: null,
    };
    public onload: ((event: ProgressEvent) => void) | null = null;
    public onerror: ((event: ProgressEvent) => void) | null = null;
    public constructor() {
      FakeUpload.last = this;
    }
    public open(method: string, url: string): void {
      this.opened = [method, url];
    }
    public setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    public send(body: Blob): void {
      this.sent = body;
    }
    public progress(loaded: number, total: number): void {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
    }
    public answer(status: number, body: unknown): void {
      this.status = status;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.onload?.({ type: 'load' } as ProgressEvent);
    }
  }

  const client = createHttp(
    () => Promise.reject(new Error('fetch is not the upload transport')),
    () => new FakeUpload(),
  );
  const current = (): FakeUpload => {
    if (FakeUpload.last === null) throw new Error('nothing was opened');
    return FakeUpload.last;
  };
  const file = new Blob(['12345678']);

  test('sends the bytes with the query, tells its progress, and believes the answer only by the schema', async () => {
    const told: [number, number][] = [];
    const done = client.upload('/api/w/uploads', Thing, file, {
      query: { id: 'a', name: 'b c' },
      onProgress: (sent, total) => {
        told.push([sent, total]);
      },
    });
    const request = current();
    expect(request.opened).toEqual(['POST', '/api/w/uploads?id=a&name=b+c']);
    expect(request.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/octet-stream',
    });
    expect(request.sent).toBe(file);
    request.progress(4, 8);
    request.progress(8, 8);
    request.answer(201, { id: 'x' });
    expect(await done).toEqual({ id: 'x' });
    expect(told).toEqual([
      [4, 8],
      [8, 8],
    ]);
  });

  test('a refusal is the error the server named, as a request’s is', async () => {
    const done = client.upload('/u', Thing, file, {}).catch((e: unknown) => e);
    current().answer(413, { error: { code: 'STORAGE_QUOTA_EXCEEDED', message: 'full' } });
    expect(await done).toMatchObject({
      status: 413,
      code: 'STORAGE_QUOTA_EXCEEDED',
      remainingBytes: null,
    });
  });

  test('a workspace out of room says how much room it still has (D-159)', async () => {
    const done = client.upload('/u', Thing, file, {}).catch((e: unknown) => e);
    current().answer(413, {
      error: {
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: 'full',
        details: { remainingBytes: 1_048_576 },
      },
    });
    expect(await done).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED', remainingBytes: 1_048_576 });
  });

  test('an answer outside the contract is MALFORMED; a dropped connection is NETWORK', async () => {
    const odd = client.upload('/u', Thing, file, {}).catch((e: unknown) => e);
    current().answer(201, { nope: true });
    expect(await odd).toMatchObject({ code: 'MALFORMED' });
    const garbled = client.upload('/u', Thing, file, {}).catch((e: unknown) => e);
    current().answer(201, 'not json');
    expect(await garbled).toMatchObject({ code: 'MALFORMED' });
    const dropped = client.upload('/u', Thing, file, {}).catch((e: unknown) => e);
    current().onerror?.({ type: 'error' } as ProgressEvent);
    const error = await dropped;
    expect(isApiError(error) && isTransient(error)).toBe(true);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK' });
  });

  test('a progress the browser cannot measure is not told', async () => {
    const told: number[] = [];
    const done = client.upload('/u', Thing, file, {
      onProgress: (sent) => {
        told.push(sent);
      },
    });
    current().upload.onprogress?.({
      lengthComputable: false,
      loaded: 3,
      total: 0,
    } as ProgressEvent);
    current().answer(201, { id: 'y' });
    await done;
    expect(told).toEqual([]);
  });

  test('by default it is the browser’s XMLHttpRequest, looked up when the upload is made', async () => {
    const original = globalThis.XMLHttpRequest;
    Object.defineProperty(globalThis, 'XMLHttpRequest', { value: FakeUpload, configurable: true });
    try {
      const done = createHttp(() => Promise.reject(new Error('no fetch'))).upload(
        '/d',
        Thing,
        file,
        {},
      );
      current().answer(201, { id: 'z' });
      expect(await done).toEqual({ id: 'z' });
    } finally {
      Object.defineProperty(globalThis, 'XMLHttpRequest', { value: original, configurable: true });
    }
  });
});

describe('a write the network never answers (#604)', () => {
  /** A `fetch` that answers only when told, and gives up as the browser does when aborted. */
  const hanging = (): {
    readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
    readonly answer: () => void;
  } => {
    let answer: () => void = () => undefined;
    const fetchFn = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        answer = (): void => {
          resolve(new Response(JSON.stringify({ id: 'a' }), { status: 200 }));
        };
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    return {
      fetchFn,
      answer: (): void => {
        answer();
      },
    };
  };

  test('is given up at its deadline as NETWORK — the failure every action already retries', async () => {
    const time = fakeSchedule();
    const { fetchFn } = hanging();
    const client = createHttp(fetchFn, undefined, time.schedule);
    let outcome: unknown = 'pending';
    void client.request('POST', '/x', Thing).then(
      () => (outcome = 'answered'),
      (error: unknown) => (outcome = error),
    );
    time.advance(WRITE_DEADLINE_MS - 1);
    await Promise.resolve();
    expect(outcome).toBe('pending');
    time.advance(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(isTransient(outcome)).toBe(true);
  });

  test('answered in time, its deadline is let go', async () => {
    const time = fakeSchedule();
    const { fetchFn, answer } = hanging();
    const client = createHttp(fetchFn, undefined, time.schedule);
    const sent = client.request('PUT', '/x', Thing);
    expect(time.pending()).toBe(1);
    answer();
    expect(await sent).toEqual({ id: 'a' });
    expect(time.pending()).toBe(0);
  });

  test('a read is not bounded here: its query owns its signal', async () => {
    const time = fakeSchedule();
    const { fetchFn, answer } = hanging();
    const client = createHttp(fetchFn, undefined, time.schedule);
    const read = client.request('GET', '/x', Thing);
    expect(time.pending()).toBe(0);
    answer();
    expect(await read).toEqual({ id: 'a' });
  });

  test('the caller’s own signal still stops a write', async () => {
    const time = fakeSchedule();
    const { fetchFn } = hanging();
    const client = createHttp(fetchFn, undefined, time.schedule);
    const stop = new AbortController();
    const sent = client.send('DELETE', '/x', { signal: stop.signal }).catch((e: unknown) => e);
    stop.abort();
    expect(await sent).toMatchObject({ code: 'NETWORK' });
    expect(time.pending()).toBe(0);
  });
});
