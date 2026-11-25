/**
 * A request is a span (#1307, D-336): it joins the trace a caller sent, or starts one, says the route's pattern and the status and
 * never the path with its ids, honours the caller's decision not to record, and costs nothing where tracing is off. On the real
 * application; the spans are the test's own sink.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import {
  createTracer,
  noTracer,
  useTracer,
  type EndedSpan,
  type Tracer,
} from '../../platform/tracing';
import { NOW, testDependencies } from '../../testing/doubles';
import { createApp, type HttpApplication } from './app';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

let cloned: ClonedDatabase;
let app: HttpApplication;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  app = createApp(testDependencies({ database: cloned.db, clock: fixedClock(NOW) }));
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

let ended: EndedSpan[] = [];
let before: Tracer = noTracer;
const tracingOn = (ratio = 1): void => {
  before = useTracer(
    createTracer({
      sink: {
        accept: (span): void => {
          ended.push(span);
        },
      },
      clock: fixedClock(NOW),
      sampleRatio: ratio,
    }),
  );
};
beforeEach(() => {
  ended = [];
});
afterEach(() => {
  useTracer(before);
});

const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  await app.handle(new Request(`https://purlay.test${path}`, { headers }));

/** The response is on its way before its after-response hook has run: give it a turn. */
const settled = async (): Promise<void> => {
  await Bun.sleep(20);
};

describe('integration: the span of a request', () => {
  test('joins the trace the caller sent, as its child, with the route’s pattern and the status', async () => {
    tracingOn();
    const response = await get('/api/me', { traceparent: `00-${TRACE}-${PARENT}-01` });
    await settled();
    expect(response.status).toBe(401);
    expect(ended).toHaveLength(1);
    const [span] = ended;
    expect(span).toMatchObject({
      name: 'request',
      kind: 'server',
      traceId: TRACE,
      parentSpanId: PARENT,
      error: false,
    });
    expect(Object.fromEntries(span?.attributes ?? [])).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 401,
    });
  });

  test('starts a trace where none was sent, and a malformed header is none', async () => {
    tracingOn();
    await get('/api/me');
    await get('/api/me', { traceparent: 'garbage' });
    await settled();
    expect(ended).toHaveLength(2);
    for (const span of ended) {
      expect(span.parentSpanId).toBeUndefined();
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(ended[0]?.traceId).not.toBe(ended[1]?.traceId);
  });

  test('says the pattern of the route and never the path: no id of the request is in what is sent', async () => {
    tracingOn();
    const workspaceId = crypto.randomUUID();
    await get(`/api/workspaces/${workspaceId}/issues?secret=hunter2`, {
      traceparent: `00-${TRACE}-${PARENT}-01`,
    });
    await settled();
    const sent = JSON.stringify([...(ended[0]?.attributes ?? [])]);
    expect(sent).not.toContain(workspaceId);
    expect(sent).not.toContain('hunter2');
    expect(JSON.stringify(ended[0]?.name)).not.toContain(workspaceId);
    expect(Object.fromEntries(ended[0]?.attributes ?? [])['http.route']).toContain(':workspaceId');
  });

  test('a caller’s decision not to record is kept: no span, whatever the ratio', async () => {
    tracingOn(1);
    await get('/api/me', { traceparent: `00-${TRACE}-${PARENT}-00` });
    await settled();
    expect(ended).toEqual([]);
  });

  test('a ratio of 0 records no trace of its own, and still joins one that was sent as recorded', async () => {
    tracingOn(0);
    await get('/api/me');
    await get('/api/me', { traceparent: `00-${TRACE}-${PARENT}-01` });
    await settled();
    expect(ended).toHaveLength(1);
    expect(ended[0]?.traceId).toBe(TRACE);
  });

  test('where tracing is off, nothing is recorded and the response carries no trace', async () => {
    const response = await get('/api/me', { traceparent: `00-${TRACE}-${PARENT}-01` });
    await settled();
    expect(ended).toEqual([]);
    expect(response.headers.get('traceparent')).toBeNull();
  });

  test('a request turned away at the edge is a span too, with the edge as its route', async () => {
    tracingOn();
    const refused = await app.handle(
      new Request('https://purlay.test/api/workspaces', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          origin: 'https://evil.test',
          traceparent: `00-${TRACE}-${PARENT}-01`,
        },
        body: 'x',
      }),
    );
    await settled();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(ended).toHaveLength(1);
    expect(Object.fromEntries(ended[0]?.attributes ?? [])['http.response.status_code']).toBe(
      refused.status,
    );
  });
});
