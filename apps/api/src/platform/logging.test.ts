/**
 * What the logger promises: nothing on the never-logged list is written, at any
 * depth or by any route — a child's bindings included, which `pino` alone let
 * through — an error is written legibly, and every line inside a request carries
 * its id (`docs/spikes/pino.md`, D-71).
 */
import { describe, expect, test } from 'bun:test';
import {
  clean,
  createLogger,
  enterRequest,
  NEVER_LOGGED,
  withinRequest,
  type Logger,
} from './logging';

const recording = (
  level: 'debug' | 'info' | 'warn' | 'error' = 'debug',
): { log: Logger; lines: Record<string, unknown>[] } => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level,
    write: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { log, lines };
};

const SECRET = 'do-not-write-me';

describe('the never-logged list', () => {
  test('no listed key reaches the output, at any depth, in fields or in bindings', () => {
    const { log, lines } = recording();
    for (const key of NEVER_LOGGED) {
      log.info('fields', { [key]: SECRET, nested: { list: [{ [key]: SECRET }] } });
      log.child({ [key]: SECRET }).info('bindings');
    }
    expect(lines.length).toBe(NEVER_LOGGED.size * 2);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  test('it holds everything ARCHITECTURE.md §10 says is never logged', () => {
    // Session tokens, the encrypted integration token, message content, email
    // addresses, a device's push address and keys (D-126) — and the carriers a token
    // arrives in. Removing one fails here, not in an incident.
    for (const key of [
      'token',
      'cookie',
      'authorization',
      'access_token_encrypted',
      'content',
      'email',
      'endpoint',
      'p256dh',
      'auth',
    ]) {
      expect({ key, listed: NEVER_LOGGED.has(key) }).toEqual({ key, listed: true });
    }
  });

  test('what is not on the list is written as it was given', () => {
    const { log, lines } = recording();
    log.info('kept', { userId: 'u1', nested: { channelId: 'c1' } });
    expect(lines[0]).toMatchObject({ msg: 'kept', userId: 'u1', nested: { channelId: 'c1' } });
  });
});

describe('what a line carries', () => {
  test('an error is its name, message and stack — never {}', () => {
    const { log, lines } = recording();
    log.error('failed', {
      err: new TypeError('the shape was wrong', { cause: new Error('below') }),
    });
    expect(lines[0]).toMatchObject({
      level: 'error',
      err: { type: 'TypeError', message: 'the shape was wrong', cause: { message: 'below' } },
    });
    expect(String((lines[0]?.['err'] as { stack?: unknown }).stack)).toContain('TypeError');
  });

  test('an AggregateError names every error inside it, with their codes, and still redacts', () => {
    // What `pg` throws when a host resolves to several addresses and none answers:
    // the message is empty and everything useful is in `errors`.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const leaky = Object.assign(new Error('boom'), { token: 'do-not-write-me' });
    const aggregate = new AggregateError([refused, leaky], '');
    const { log, lines } = recording();
    log.error('request failed', { err: aggregate });

    expect(lines[0]).toMatchObject({
      err: {
        type: 'AggregateError',
        errors: [
          {
            type: 'Error',
            message: 'connect ECONNREFUSED 127.0.0.1:5432',
            errorCode: 'ECONNREFUSED',
          },
          { type: 'Error', message: 'boom' },
        ],
      },
    });
    expect(JSON.stringify(lines)).not.toContain('do-not-write-me');
  });

  test('an error code is written for any error, as errorCode — the word `code` stays redacted', () => {
    const { log, lines } = recording();
    log.error('failed', { err: Object.assign(new Error('x'), { code: '23505' }), code: 'oauth' });
    expect(lines[0]).toMatchObject({ err: { errorCode: '23505' }, code: '[redacted]' });
  });

  test('a structure too deep, or with a cycle, is cut off rather than followed', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(JSON.stringify(clean(cycle))).toContain('[too deep]');
  });

  test('levels below the configured one are not written', () => {
    const { log, lines } = recording('warn');
    log.info('quiet');
    log.warn('loud');
    expect(lines.map((line) => line['msg'])).toEqual(['loud']);
  });
});

describe('the request a line belongs to', () => {
  test('lines inside a request carry its id, through awaits, without crossing', async () => {
    const { log, lines } = recording();
    await Promise.all(
      ['first', 'second'].map(async (requestId, index) => {
        await withinRequest({ requestId, startedAt: 0 }, async () => {
          await Bun.sleep(index === 0 ? 20 : 5);
          log.info('after an await', { which: requestId });
        });
      }),
    );
    for (const line of lines) expect(line['requestId']).toBe(line['which']);
    expect(lines).toHaveLength(2);
  });

  test('entering a request makes the rest of the flow that request', async () => {
    const { log, lines } = recording();
    await withinRequest({ requestId: 'outer', startedAt: 0 }, async () => {
      enterRequest({ requestId: 'entered', startedAt: 0 });
      await Bun.sleep(1);
      log.info('inside');
    });
    expect(lines[0]?.['requestId']).toBe('entered');
  });

  test('a line outside any request carries no id rather than a stale one', () => {
    const { log, lines } = recording();
    log.info('outside');
    expect(lines[0]).not.toHaveProperty('requestId');
  });
});
