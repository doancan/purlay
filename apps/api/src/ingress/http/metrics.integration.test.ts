/**
 * `/metrics` against a real database and a real listener (D-221): the scheduled jobs' record read from
 * `job_runs`, a socket counted while it is open and its refused frames counted as it is refused, a
 * `429` counted at the HTTP door — and, after a person has signed in, written in a workspace and been
 * answered, nothing on the page that is theirs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from './rate-limit';
import { fixedClock } from '../../platform/clock';
import { serverMetrics, type ServerMetrics } from '../../platform/metrics';
import { PLAN } from '../../modules/jobs/schedule';
import { testConfig, testDependencies } from '../../testing/doubles';
import { readExposition, sampleOf, type ReadPage } from '../../testing/exposition';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';
const TOKEN = '7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26';

let cloned: ClonedDatabase;
let db: Executor;
let app: HttpApplication;
let metrics: ServerMetrics;
let port = 0;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  metrics = serverMetrics();
  app = createApp(
    testDependencies({
      database: db,
      clock,
      metrics,
      config: testConfig({ APP_URL: ORIGIN, METRICS_TOKEN: TOKEN }),
      // One request of `GET /api/client` at once, so the second is the HTTP door's 429.
      rateBudgets: {
        auth: { perSecond: AUTH_BUDGET.perSecond, burst: 1 },
        writes: WRITE_BUDGET,
        costlyReads: COSTLY_READ_BUDGET,
      },
    }),
  );
  port = app.listen(0);
});

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

const call = async (
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const scrapeText = async (): Promise<string> => {
  const response = await app.handle(
    new Request(`${ORIGIN}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } }),
  );
  expect(response.status).toBe(200);
  return await response.text();
};

const scrape = async (): Promise<ReadPage> => readExposition(await scrapeText());

/** Waits for a value on the page to be what is expected: the positive condition, never a pause. */
const until = async (
  name: string,
  labels: Readonly<Record<string, string>>,
  expected: number,
): Promise<ReadPage> => {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const page = await scrape();
    const value = sampleOf(page, name, labels);
    if (value === expected) return page;
    if (performance.now() > deadline) {
      throw new Error(
        `${name} ${JSON.stringify(labels)}: expected ${String(expected)}, saw ${String(value)}`,
      );
    }
    await Bun.sleep(5);
  }
};

describe('integration: the scheduled jobs on the page', () => {
  test('are read from their record: when each last succeeded, and how often it has failed since', async () => {
    const [first, second] = PLAN.map((slot) => slot.job);
    if (first === undefined || second === undefined)
      throw new Error('the plan has fewer than two jobs');
    const succeeded = new Date('2026-10-31T03:00:00.000Z');
    await db
      .insertInto('job_runs')
      .values([
        { job_name: first, last_started_at: succeeded, last_success_at: succeeded },
        { job_name: second, last_started_at: NOW, last_success_at: null, consecutive_failures: 3 },
      ])
      .execute();
    const page = await scrape();
    expect(sampleOf(page, 'purlay_jobs_status_readable')).toBe(1);
    expect(sampleOf(page, 'purlay_job_last_success_timestamp_seconds', { job: first })).toBe(
      succeeded.getTime() / 1000,
    );
    expect(
      sampleOf(page, 'purlay_job_last_success_timestamp_seconds', { job: second }),
    ).toBeUndefined();
    expect(sampleOf(page, 'purlay_job_consecutive_failures', { job: second })).toBe(3);
    // Every planned job has its failure count, whether or not it has ever run.
    for (const { job } of PLAN) {
      expect(sampleOf(page, 'purlay_job_consecutive_failures', { job })).toBeDefined();
    }
  });
});

describe('integration: what a person does is counted, and nothing of theirs is on the page', () => {
  test('a sign-in, a workspace, a channel and a message move the counts by route, and leave no name, address, id or word', async () => {
    const person = await aSignedInUser(db, clock, 'şükrü');
    const slug = aUniqueSlug('gizli-proje');
    const workspace = await call('POST', '/api/workspaces', {
      cookie: person.cookie,
      body: { name: 'Gizli Proje Çalışma Alanı', slug },
    });
    expect(workspace.status).toBe(201);
    const workspaceId = ((await workspace.json()) as { id: string }).id;
    const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, {
      cookie: person.cookie,
      body: { name: 'maaşlar' },
    });
    expect(channel.status).toBe(201);
    const channelId = ((await channel.json()) as { id: string }).id;
    const id = messageId(NOW);
    const content = 'Zam oranı %12 — kimseye söyleme 🙂 <script>alert(1)</script>';
    const sent = await call('POST', `/api/channels/${channelId}/messages`, {
      cookie: person.cookie,
      body: { id, content },
    });
    expect(sent.status).toBe(201);
    expect(
      (await call('GET', `/api/channels/${channelId}/messages`, { cookie: person.cookie })).status,
    ).toBe(200);

    await until(
      'purlay_http_request_duration_seconds_count',
      { method: 'POST', route: '/api/channels/:channelId/messages', status: '2xx' },
      1,
    );
    const text = await scrapeText();
    const page = readExposition(text);
    expect(
      sampleOf(page, 'purlay_http_request_duration_seconds_count', {
        method: 'POST',
        route: '/api/workspaces',
        status: '2xx',
      }),
    ).toBe(1);
    for (const theirs of [
      person.userId,
      person.username,
      person.email,
      person.sessionId,
      'şükrü',
      slug,
      'Gizli',
      'maaş',
      workspaceId,
      channelId,
      id,
      'Zam',
      'kimseye',
      '<script>',
    ]) {
      expect({ theirs, found: text.includes(theirs) }).toEqual({ theirs, found: false });
    }
  });
});

describe('integration: the socket and the rate on the page', () => {
  test('an open socket is counted while it is open, and its frames refused for the rate are counted as they are refused', async () => {
    const { cookie } = await aSignedInUser(db, clock, 'socket');
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    const refusals: unknown[] = [];
    let answered = 0;
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { event?: string; data?: { code?: string } };
      answered += 1;
      if (frame.event === 'ERROR' && frame.data?.code === 'RATE_LIMITED') refusals.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the socket did not open'));
      });
    });
    await until('purlay_websocket_connections', {}, 1);

    // The connection's burst is sixty frames and the clock stands still, so ten past it are refused.
    // One at a time, each answered before the next: a queue past its bound closes the socket instead.
    for (let frame = 0; frame < 70; frame += 1) {
      socket.send('not a frame');
      const deadline = performance.now() + 2_000;
      while (answered <= frame) {
        if (performance.now() > deadline)
          throw new Error(`frame ${String(frame)} was not answered`);
        await Bun.sleep(1);
      }
    }
    await until('purlay_rate_limited_total', { door: 'socket' }, 10);
    expect(refusals).toHaveLength(10);

    socket.close();
    await until('purlay_websocket_connections', {}, 0);
  });

  test('a request refused for the rate at the HTTP door is counted there', async () => {
    const before = sampleOf(await scrape(), 'purlay_rate_limited_total', { door: 'http' }) ?? 0;
    expect((await call('GET', '/api/client')).status).toBe(200);
    const refused = await call('GET', '/api/client');
    expect(refused.status).toBe(429);
    expect(sampleOf(await scrape(), 'purlay_rate_limited_total', { door: 'http' })).toBe(
      before + 1,
    );
  });
});
