/**
 * `GET /metrics` through the real router (D-221): off without its token, absent to whoever does not
 * hold it, and a page Prometheus can read for whoever does — naming each request by the route it was
 * registered as and never by what the caller wrote.
 *
 * The database here throws on any use, so the scheduled jobs' record is unreadable in every test of
 * this file; the page is answered all the same, which is the partial failure it is built for.
 */
import { describe, expect, test } from 'bun:test';
import { createApp, type HttpApplication } from './app';
import { serverMetrics, type ServerMetrics } from '../../platform/metrics';
import { aRecordingLogger, testConfig, testDependencies } from '../../testing/doubles';
import { readExposition, sampleOf, type ReadPage } from '../../testing/exposition';
import {
  holdsMetricsToken,
  methodLabel,
  routeLabel,
  statusLabel,
  EDGE_ROUTE,
  UNMATCHED_ROUTE,
} from './metrics';

const TOKEN = 'b1946ac92492d2347c6235b4d2611184b1946ac92492d2347c6235b4d2611184';
const ORIGIN = 'https://purlay.test';

const anApp = (
  { token }: { token: string | undefined } = { token: TOKEN },
): { app: HttpApplication; metrics: ServerMetrics; lines: Record<string, unknown>[] } => {
  const metrics = serverMetrics();
  const { log, lines } = aRecordingLogger();
  const app = createApp(
    testDependencies({
      metrics,
      log,
      config: testConfig(token === undefined ? {} : { METRICS_TOKEN: token }),
    }),
  );
  return { app, metrics, lines };
};

const get = async (
  app: HttpApplication,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> => await app.handle(new Request(`${ORIGIN}${path}`, { headers }));

const scrape = async (app: HttpApplication): Promise<Response> =>
  await get(app, '/metrics', { authorization: `Bearer ${TOKEN}` });

const pageOf = async (app: HttpApplication): Promise<ReadPage> => {
  const response = await scrape(app);
  expect(response.status).toBe(200);
  return readExposition(await response.text());
};

/** What a response says to a caller: everything but the id it was given, which is new each time. */
const asSeen = async (
  response: Response,
): Promise<{ status: number; body: string; headers: [string, string][] }> => ({
  status: response.status,
  body: await response.text(),
  headers: [...response.headers.entries()].filter(([name]) => name !== 'x-request-id').sort(),
});

/**
 * The request's line on the page is written after its answer has gone (`onAfterResponse`): waited for
 * as the count reaching what is expected, not as time passing.
 */
const untilCounted = async (
  metrics: ServerMetrics,
  labels: Readonly<Record<string, string>>,
  expected: number,
): Promise<void> => {
  const deadline = performance.now() + 2_000;
  for (;;) {
    const family = metrics.registry
      .families()
      .find((one) => one.name === 'purlay_http_request_duration_seconds');
    const count = family?.samples.find(
      (sample) =>
        sample.suffix === '_count' &&
        Object.entries(labels).every(([name, value]) => sample.labels[name] === value),
    )?.value;
    if (count === expected) return;
    if (performance.now() > deadline) {
      throw new Error(`expected ${String(expected)} requests counted, saw ${String(count)}`);
    }
    await Bun.sleep(1);
  }
};

describe('metrics, switched off', () => {
  test('without METRICS_TOKEN the page is the 404 of any path nothing serves, whatever the caller sends', async () => {
    const { app } = anApp({ token: undefined });
    const nothing = await asSeen(await get(app, '/no-such-page'));
    expect(nothing.status).toBe(404);
    for (const headers of [
      {},
      { authorization: `Bearer ${TOKEN}` },
      { authorization: 'Bearer x' },
    ]) {
      expect(await asSeen(await get(app, '/metrics', headers))).toEqual(nothing);
    }
  });
});

describe('metrics, switched on', () => {
  test('no token, a wrong one, another scheme or a near miss is the same 404 as a path nothing serves', async () => {
    const { app, lines } = anApp();
    const nothing = await asSeen(await get(app, '/no-such-page'));
    const refused = [
      {},
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: `Basic ${TOKEN}` },
      { authorization: TOKEN },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${TOKEN}0` },
      { authorization: `Bearer ${TOKEN.toUpperCase()}` },
      { authorization: `Bearer ${TOKEN} ${TOKEN}` },
      { authorization: `Bearer ${'ç'.repeat(64)}` },
      { authorization: `Bearer ${'x'.repeat(8_000)}` },
    ];
    for (const headers of refused) {
      expect(await asSeen(await get(app, '/metrics', headers))).toEqual(nothing);
    }
    // The operator is told a scraper was turned away, and never what it sent.
    const said = lines.filter((line) => String(line['msg']).startsWith('a request for metrics'));
    expect(said).toHaveLength(refused.length);
    expect(JSON.stringify(lines)).not.toContain(TOKEN.slice(0, 16));
  });

  test('the token, as a bearer, is answered with a page Prometheus reads, never cached', async () => {
    const { app } = anApp();
    const response = await scrape(app);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const page = readExposition(await response.text());
    for (const family of [
      'purlay_process_uptime_seconds',
      'purlay_process_resident_memory_bytes',
      'purlay_websocket_connections',
      'purlay_http_request_duration_seconds',
      'purlay_rate_limited_total',
      'purlay_push_failures_total',
      'purlay_mail_failures_total',
      'purlay_jobs_status_readable',
    ]) {
      expect({ family, typed: page.types.has(family) }).toEqual({ family, typed: true });
    }
    expect(sampleOf(page, 'purlay_websocket_connections')).toBe(0);
  });

  test('the scheme is read in any case, as HTTP reads it', async () => {
    const { app } = anApp();
    expect((await get(app, '/metrics', { authorization: `bearer ${TOKEN}` })).status).toBe(200);
  });

  test('a database that cannot be read still leaves the page, saying the jobs are unknown', async () => {
    const { app, lines } = anApp();
    expect(sampleOf(await pageOf(app), 'purlay_jobs_status_readable')).toBe(0);
    expect(sampleOf(await pageOf(app), 'purlay_jobs_status_readable')).toBe(0);
    const said = lines.filter((line) =>
      String(line['msg']).includes('could not be read for metrics'),
    );
    expect(said).toHaveLength(1);
  });

  test('a path under it is the API’s, never the client’s page: the same 404 without the token', async () => {
    const { app } = anApp();
    const nothing = await asSeen(await get(app, '/no-such-page'));
    expect(await asSeen(await get(app, '/metrics/'))).toEqual(nothing);
    expect(await asSeen(await get(app, '/metrics/x'))).toEqual(nothing);
  });
});

describe('what the page counts', () => {
  test('each request, by method, the route as it was registered and the class of its status', async () => {
    const { app, metrics } = anApp();
    for (let i = 0; i < 3; i += 1) expect((await get(app, '/health')).status).toBe(200);
    const id = crypto.randomUUID();
    expect((await get(app, `/api/channels/${id}`)).status).toBe(401);
    await untilCounted(metrics, { route: '/health' }, 3);
    await untilCounted(metrics, { route: '/api/channels/:channelId' }, 1);
    const page = await pageOf(app);
    expect(
      sampleOf(page, 'purlay_http_request_duration_seconds_count', {
        method: 'GET',
        route: '/health',
        status: '2xx',
      }),
    ).toBe(3);
    expect(
      sampleOf(page, 'purlay_http_request_duration_seconds_bucket', {
        method: 'GET',
        route: '/api/channels/:channelId',
        status: '4xx',
        le: '+Inf',
      }),
    ).toBe(1);
  });

  /**
   * Cardinality is privacy here: a thousand paths nobody serves, each with an id, an address and a
   * name in it, are one series — and none of what they carried is on the page.
   */
  test('a thousand different paths, ids and words in them, are one series, and none of their words is on the page', async () => {
    const { app, metrics } = anApp();
    const carried: string[] = [];
    await Promise.all(
      Array.from({ length: 1_000 }, async (_, at) => {
        const id = crypto.randomUUID();
        carried.push(id);
        const path = `/api/no-such/${id}/ayşe.yılmaz@example.com/çalışma-alanı-${String(at)}?q=gizli+mesaj`;
        expect((await get(app, encodeURI(path))).status).toBe(404);
      }),
    );
    await untilCounted(metrics, { route: '/*' }, 1_000);
    const text = await (await scrape(app)).text();
    const page = readExposition(text);
    // One histogram's worth of series for all of them: its buckets, +Inf, sum and count.
    const routes = page.samples.flatMap((sample) => sample.labels['route'] ?? []);
    expect(new Set(routes)).toEqual(new Set(['/*']));
    expect(routes.filter((route) => route === '/*')).toHaveLength(14);
    for (const word of [
      'ayşe',
      'example.com',
      'çalışma',
      'gizli',
      'no-such',
      ...carried.slice(0, 50),
    ]) {
      expect({ word, found: text.includes(word) }).toEqual({ word, found: false });
    }
  });

  test('a request turned away at the edge is counted, under a route of its own', async () => {
    const { app, metrics } = anApp();
    const refused = await app.handle(
      new Request(`${ORIGIN}/api/workspaces`, {
        method: 'POST',
        headers: { origin: 'https://elsewhere.test', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(refused.status).toBe(403);
    await untilCounted(metrics, { route: EDGE_ROUTE }, 1);
    expect(
      sampleOf(await pageOf(app), 'purlay_http_request_duration_seconds_count', {
        method: 'POST',
        route: EDGE_ROUTE,
        status: '4xx',
      }),
    ).toBe(1);
  });

  test('requests and scrapes at once are each counted once, and every page reads', async () => {
    const { app, metrics } = anApp();
    const pages = await Promise.all(
      Array.from({ length: 100 }, async (_, at) =>
        at % 10 === 0 ? await (await scrape(app)).text() : (await get(app, '/health')).status,
      ),
    );
    for (const page of pages) {
      if (typeof page === 'string') expect(() => readExposition(page)).not.toThrow();
      else expect(page).toBe(200);
    }
    await untilCounted(metrics, { route: '/health' }, 90);
    await untilCounted(metrics, { route: '/metrics' }, 10);
  });
});

describe('the labels', () => {
  test('a method nobody registers is one label, so a caller cannot make series', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methodLabel(method)).toBe(method);
    }
    for (const method of ['FOO', 'get', 'PROPFIND', '']) expect(methodLabel(method)).toBe('OTHER');
  });

  test('a status is its class, and a number that is no status is one label too', () => {
    expect([100, 200, 204, 302, 404, 429, 503, 599].map(statusLabel)).toEqual([
      '1xx',
      '2xx',
      '2xx',
      '3xx',
      '4xx',
      '4xx',
      '5xx',
      '5xx',
    ]);
    for (const status of [0, 99, 600, 200.5, Number.NaN]) expect(statusLabel(status)).toBe('other');
  });

  test('a request no route took is named as such, not by its path', () => {
    expect(routeLabel(undefined)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel('')).toBe(UNMATCHED_ROUTE);
    expect(routeLabel('/api/channels/:channelId')).toBe('/api/channels/:channelId');
  });
});

describe('the token check', () => {
  test('holds for the token as a bearer and for nothing else', () => {
    expect(holdsMetricsToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(holdsMetricsToken(`Bearer  ${TOKEN}`, TOKEN)).toBe(true);
    expect(holdsMetricsToken(null, TOKEN)).toBe(false);
    expect(holdsMetricsToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(holdsMetricsToken(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(holdsMetricsToken(`Token ${TOKEN}`, TOKEN)).toBe(false);
  });
});
