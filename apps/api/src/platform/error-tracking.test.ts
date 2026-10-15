/**
 * What error tracking promises (#248, D-96): it is off unless asked for and then
 * sends nothing the log would not write, it can never make the process worse, and
 * it needs no vendor library.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from './clock';
import {
  createErrorTracker,
  ErrorTrackingConfigurationError,
  noErrorTracking,
  parseDsn,
  withErrorTracking,
  type Delivery,
  errorTrackingFor,
  reportUrgently,
} from './error-tracking';
import { createLogger, withinRequest, type Logger } from './logging';

const DSN = 'https://abc123publickey@errors.example.test/42';
const NOW = new Date('2026-10-09T12:00:00.000Z');

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const recorder = (outcome: 'ok' | 'reject' | 'refuse' = 'ok'): { sent: Sent[]; send: Delivery } => {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (url, init): Promise<{ readonly ok: boolean }> => {
      await Promise.resolve();
      sent.push({ url, headers: init.headers, body: init.body });
      if (outcome === 'reject') throw new Error('network is down');
      if (outcome === 'refuse') return { ok: false };
      return { ok: true };
    },
  };
};

describe('parseDsn', () => {
  test('reads the key, the host and the project out of a Sentry-style DSN', () => {
    expect(parseDsn(DSN)).toEqual({
      key: 'abc123publickey',
      endpoint: 'https://errors.example.test/api/42/envelope/',
    });
  });

  test('keeps a path prefix and a port', () => {
    expect(parseDsn('https://k@host.example.test:8443/sentry/7').endpoint).toBe(
      'https://host.example.test:8443/sentry/api/7/envelope/',
    );
  });

  test.each([
    'not a url',
    'https://host.example.test/42', // no key
    'https://k@host.example.test/', // no project
    'https://k@host.example.test/abc', // project is not a number
    'ftp://k@host.example.test/1',
  ])('refuses %j, at boot, naming the variable', (dsn) => {
    expect(() => parseDsn(dsn)).toThrow(ErrorTrackingConfigurationError);
    expect(() => parseDsn(dsn)).toThrow(/ERROR_TRACKING_DSN/);
  });

  test('never repeats the key in the refusal', () => {
    try {
      parseDsn('https://secretkey123@host.example.test/not-a-number');
    } catch (error) {
      expect(String(error)).not.toContain('secretkey123');
    }
  });
});

describe('off by default', () => {
  test('without a DSN there is no tracker that can send, and nothing is sent', async () => {
    const { sent, send } = recorder();
    const tracker = createErrorTracker({
      dsn: undefined,
      environment: 'production',
      clock: fixedClock(NOW),
      send,
    });
    tracker.capture({ message: 'boom', fields: { err: { type: 'Error', message: 'x' } } });
    await tracker.flush();
    expect(tracker).toBe(noErrorTracking);
    expect(sent).toEqual([]);
  });

  test('an empty DSN is off as well, not a configuration error', () => {
    const tracker = createErrorTracker({
      dsn: '',
      environment: 'production',
      clock: fixedClock(NOW),
      send: recorder().send,
    });
    expect(tracker).toBe(noErrorTracking);
  });
});

describe('a DSN that would send reports in the clear', () => {
  test('is refused in production and allowed elsewhere', () => {
    const options = {
      dsn: 'http://k@errors.example.test/1',
      clock: fixedClock(NOW),
      send: recorder().send,
    };
    expect(() => createErrorTracker({ ...options, environment: 'production' })).toThrow(
      /https:\/\/ in production/,
    );
    expect(createErrorTracker({ ...options, environment: 'development' })).not.toBe(
      noErrorTracking,
    );
  });
});

describe('when a DSN is set', () => {
  const build = (
    outcome: 'ok' | 'reject' | 'refuse' = 'ok',
    failures: unknown[] = [],
  ): ReturnType<typeof recorder> & { tracker: ReturnType<typeof createErrorTracker> } => {
    const r = recorder(outcome);
    const tracker = createErrorTracker({
      dsn: DSN,
      environment: 'production',
      clock: fixedClock(NOW),
      send: r.send,
      onFailure: (error) => failures.push(error),
    });
    return { ...r, tracker };
  };

  test('posts one envelope in the Sentry wire format, with the key in the auth header', async () => {
    const { tracker, sent } = build();
    tracker.capture({
      message: 'request failed',
      fields: {
        err: { type: 'TypeError', message: 'x is not a function', stack: 'TypeError: x\n  at y' },
        path: '/api/channels',
      },
    });
    await tracker.flush();

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://errors.example.test/api/42/envelope/');
    expect(request?.headers['X-Sentry-Auth']).toBe(
      'Sentry sentry_version=7, sentry_client=purlay/1, sentry_key=abc123publickey',
    );
    expect(request?.headers['Content-Type']).toBe('application/x-sentry-envelope');

    const [envelopeHeader, itemHeader, event] = (request?.body ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(envelopeHeader).toMatchObject({ sent_at: '2026-10-09T12:00:00.000Z' });
    expect(typeof envelopeHeader?.['event_id']).toBe('string');
    expect(itemHeader).toEqual({ type: 'event' });
    expect(event).toMatchObject({
      timestamp: '2026-10-09T12:00:00.000Z',
      platform: 'javascript',
      level: 'error',
      environment: 'production',
      message: 'request failed',
      exception: { values: [{ type: 'TypeError', value: 'x is not a function' }] },
      extra: { path: '/api/channels', stack: 'TypeError: x\n  at y' },
    });
    expect(event?.['event_id']).toBe(envelopeHeader?.['event_id']);
  });

  test('an event without an error still carries its message', async () => {
    const { tracker, sent } = build();
    tracker.capture({ message: 'a worker stalled', fields: { queue: 'unfurl' } });
    await tracker.flush();
    const event = JSON.parse((sent[0]?.body ?? '').trim().split('\n')[2] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(event['message']).toBe('a worker stalled');
    expect(event['exception']).toBeUndefined();
    expect(event['extra']).toEqual({ queue: 'unfurl' });
  });

  test('a transport that rejects, or refuses, never throws into the caller and is reported once each', async () => {
    for (const outcome of ['reject', 'refuse'] as const) {
      const failures: unknown[] = [];
      const { tracker } = build(outcome, failures);
      expect(() => {
        tracker.capture({ message: 'boom', fields: {} });
      }).not.toThrow();
      await tracker.flush();
      expect(failures).toHaveLength(1);
    }
  });

  test('a burst beyond the in-flight bound is dropped and counted rather than queued without limit', async () => {
    const failures: unknown[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const tracker = createErrorTracker({
      dsn: DSN,
      environment: 'production',
      clock: fixedClock(NOW),
      maxInFlight: 3,
      send: async (_url, init): Promise<{ readonly ok: boolean }> => {
        sent.push(init.body);
        await gate;
        return { ok: true };
      },
      onFailure: (error) => failures.push(error),
    });

    for (let i = 0; i < 10; i += 1) tracker.capture({ message: `boom ${String(i)}`, fields: {} });
    expect(sent).toHaveLength(3);
    release();
    await tracker.flush();
    expect(tracker.dropped()).toBe(7);
    // After the burst there is room again.
    tracker.capture({ message: 'later', fields: {} });
    await tracker.flush();
    expect(sent).toHaveLength(4);
  });
});

describe('withErrorTracking', () => {
  const recording = (): { log: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({
      level: 'debug',
      write: (line) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    return { log, lines };
  };

  test('reports what is logged at error, cleaned exactly as the log is, and nothing else', async () => {
    const { send, sent } = recorder();
    const tracker = createErrorTracker({
      dsn: DSN,
      environment: 'production',
      clock: fixedClock(NOW),
      send,
    });
    const { log, lines } = recording();
    const tracked = withErrorTracking(log, tracker);

    tracked.info('listening', { port: 1 });
    tracked.warn('slow', { ms: 900 });
    tracked.error('request failed', {
      err: new RangeError('out of range'),
      email: 'private@example.test',
      content: 'a private message',
      nested: { token: 'session-secret', path: '/x' },
    });
    await tracker.flush();

    // The log got every line; the tracker got only the error.
    expect(lines.map((line) => line['msg'])).toEqual(['listening', 'slow', 'request failed']);
    expect(sent).toHaveLength(1);

    const body = sent[0]?.body ?? '';
    for (const secret of ['private@example.test', 'a private message', 'session-secret']) {
      expect(body).not.toContain(secret);
    }
    expect(body).toContain('RangeError');
    expect(body).toContain('out of range');
    expect(body).toContain('/x');
  });

  test('a report carries the id of the request it happened in, as the log line does', async () => {
    const { send, sent } = recorder();
    const tracker = createErrorTracker({
      dsn: DSN,
      environment: 'production',
      clock: fixedClock(NOW),
      send,
    });
    const tracked = withErrorTracking(recording().log, tracker);
    withinRequest({ requestId: 'req-123', startedAt: 0 }, () => {
      tracked.error('request failed', {});
    });
    await tracker.flush();
    expect(sent[0]?.body).toContain('"requestId":"req-123"');
  });

  test('a child logger keeps reporting, with its bindings', async () => {
    const { send, sent } = recorder();
    const tracker = createErrorTracker({
      dsn: DSN,
      environment: 'production',
      clock: fixedClock(NOW),
      send,
    });
    const tracked = withErrorTracking(recording().log, tracker).child({ channel: 'c1' });
    tracked.error('frame failed', {});
    await tracker.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('"channel":"c1"');
  });

  test('with tracking off the logger is the logger', () => {
    const { log } = recording();
    expect(withErrorTracking(log, noErrorTracking)).toBe(log);
  });

  test('a tracker that fails inside error() does not stop the line being logged or throw', () => {
    const { log, lines } = recording();
    const exploding = {
      capture: (): void => {
        throw new Error('tracker bug');
      },
      flush: async (): Promise<void> => {
        await Promise.resolve();
      },
      dropped: (): number => 0,
    };
    const tracked = withErrorTracking(log, exploding);
    expect(() => {
      tracked.error('still logged', {});
    }).not.toThrow();
    // The line is kept, and the tracker's failure is itself logged — at warn, which
    // is not reported in turn.
    expect(lines.map((line) => [line['level'], line['msg']])).toEqual([
      ['error', 'still logged'],
      ['warn', 'error tracking failed'],
    ]);
  });
});

describe('a process tracked as its configuration says (#635)', () => {
  test('an error line is reported; a failed report is said on the plain log, at warn', async () => {
    const lines: { level: string; message: string }[] = [];
    const plain = {
      ...createLogger({ level: 'silent' }),
      warn: (message: string): void => {
        lines.push({ level: 'warn', message });
      },
      error: (message: string): void => {
        lines.push({ level: 'error', message });
      },
    };
    const sent: string[] = [];
    const { log, tracker } = errorTrackingFor(
      { ERROR_TRACKING_DSN: 'https://key@errors.example/1', NODE_ENV: 'production' },
      plain,
      { now: () => new Date('2026-10-15T12:00:00.000Z') },
      async (url) => {
        sent.push(url);
        await Promise.resolve();
        return new Response(null, { status: 500 });
      },
    );
    log.error('a job failed', {});
    await tracker.flush();
    expect(sent).toHaveLength(1);
    expect(lines).toEqual([
      { level: 'error', message: 'a job failed' },
      { level: 'warn', message: 'an error report was not delivered' },
    ]);
  });

  test('reports dropped under a storm are said on the plain log, at warn', () => {
    const warned: string[] = [];
    const plain = {
      ...createLogger({ level: 'silent' }),
      warn: (message: string): void => {
        warned.push(message);
      },
    };
    const { log } = errorTrackingFor(
      { ERROR_TRACKING_DSN: 'https://key@errors.example/1', NODE_ENV: 'production' },
      plain,
      { now: () => new Date('2026-10-15T12:00:00.000Z') },
      // A collector that never answers: every slot stays taken.
      () => new Promise<Response>(() => undefined),
    );
    for (let i = 0; i < 11; i += 1) log.error('storm', {});
    expect(warned).toEqual(['error reports are being dropped; the collector is not keeping up']);
  });

  test('without a DSN nothing is reported and the logger is the plain one', () => {
    const plain = createLogger({ level: 'silent' });
    const { log } = errorTrackingFor({ NODE_ENV: 'production' }, plain, {
      now: () => new Date(),
    });
    expect(log).toBe(plain);
  });
});

describe('a crash reported urgently (#634)', () => {
  test('goes to the tracker as urgent, its fields cleaned as a log line is', () => {
    const captured: { error: unknown; priority: unknown }[] = [];
    const tracker = {
      ...noErrorTracking,
      capture: (error: unknown, priority?: 'urgent'): void => {
        captured.push({ error, priority });
      },
    };
    reportUrgently(tracker)('an error escaped every handler; exiting', {
      kind: 'uncaughtException',
      authorization: 'Bearer secret',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.priority).toBe('urgent');
    expect(JSON.stringify(captured[0]?.error)).not.toContain('secret');
  });
});
