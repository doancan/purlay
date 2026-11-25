/**
 * A fact carries the trace it was published in (#1307, D-336): the request's span is written to the row as `traceparent`, and the
 * delivery, on another node and later, is a child span of it, in the same trace, with the fact's type and consumer and what came of
 * it. Where nothing is recorded the row carries nothing and the delivery starts a trace of its own. Real PostgreSQL, through the
 * drain's own entry point and the publisher's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { aMovableClock, aRecordingLogger, NOW } from '../testing/doubles';
import { aPublishWorld, aWorkspaceRow, NOTE_CREATED } from '../testing/facts';
import type { FactConsumer } from './fact-consumers';
import { drainOnce, type FactHandling, type Handled } from './outbox-drain';
import { publishFact } from './outbox';
import { withinRequest } from './logging';
import {
  createTracer,
  formatTraceparent,
  noTracer,
  tracer,
  useTracer,
  type EndedSpan,
  type Tracer,
} from './tracing';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const wiki: Handled = { consumer: 'wiki', type: 'notes.created', shape: 1 };
const handlers = (handle: FactConsumer): readonly (Handled & FactHandling)[] => [
  { ...wiki, declaration: NOTE_CREATED, handle },
];
const delivers: FactConsumer = () => Promise.resolve('done');
const skips: FactConsumer = () => Promise.resolve('skipped');
const breaks: FactConsumer = () => Promise.reject(new Error('the consumer is down'));

let ended: EndedSpan[] = [];
const tracingOn = (ratio = 1): Tracer =>
  useTracer(
    createTracer({
      sink: {
        accept: (span): void => {
          ended.push(span);
        },
      },
      clock: aMovableClock(NOW),
      sampleRatio: ratio,
    }),
  );
beforeEach(() => {
  ended = [];
});

/** Publishes `notes.created` in a request whose span is `parent`, or in none. */
const publishIn = async (
  workspaceId: string,
  parent: ReturnType<Tracer['start']> | undefined,
): Promise<void> => {
  const write = async (): Promise<void> => {
    await cloned.db.transaction().execute(async (tx) => {
      await publishFact(tx, aPublishWorld(workspaceId, aMovableClock(NOW)).context, NOTE_CREATED, {
        noteId: 'n',
        title: 't',
      });
    });
  };
  if (parent === undefined) {
    await write();
    return;
  }
  await withinRequest({ requestId: 'req-1', startedAt: 0, module: 'notes', span: parent }, write);
};

const drain = async (handle: FactConsumer): Promise<void> => {
  await drainOnce(cloned.db, {
    handlers: handlers(handle),
    batch: 10,
    clock: aMovableClock(NOW),
    log: aRecordingLogger().log,
  });
};

const traceOf = async (workspaceId: string): Promise<string | null> =>
  (
    await cloned.db
      .selectFrom('outbox')
      .select('traceparent')
      .where('workspace_id', '=', workspaceId)
      .where('consumer', '=', 'wiki')
      .executeTakeFirstOrThrow()
  ).traceparent;

describe('integration: the trace of a fact', () => {
  test('is the request’s span, written with the row, and the delivery is its child in the same trace', async () => {
    const before = tracingOn();
    try {
      const workspaceId = await aWorkspaceRow(cloned.db);
      const request = tracer().start('request', { kind: 'server' });
      await publishIn(workspaceId, request);
      expect(await traceOf(workspaceId)).toBe(formatTraceparent(request.context));
      await drain(delivers);
      request.end();
      const delivery = ended.find((span) => span.name === 'fact.deliver');
      expect(delivery).toMatchObject({
        kind: 'consumer',
        traceId: request.context.traceId,
        parentSpanId: request.context.spanId,
        error: false,
      });
      expect(Object.fromEntries(delivery?.attributes ?? [])).toEqual({
        'purlay.fact.type': 'notes.created',
        'purlay.fact.consumer': 'wiki',
        'purlay.fact.outcome': 'delivered',
      });
    } finally {
      useTracer(before);
    }
  });

  test('says what came of a delivery: skipped is no error, a handler that threw is one', async () => {
    const before = tracingOn();
    try {
      const skipped = await aWorkspaceRow(cloned.db);
      await publishIn(skipped, tracer().start('request'));
      await drain(skips);
      const failed = await aWorkspaceRow(cloned.db);
      await publishIn(failed, tracer().start('request'));
      await sql`update outbox set next_attempt_at = ${NOW} where workspace_id = ${failed}`.execute(
        cloned.db,
      );
      await drain(breaks);
      const deliveries = ended.filter((span) => span.name === 'fact.deliver');
      expect(
        deliveries
          .map((span) => [Object.fromEntries(span.attributes)['purlay.fact.outcome'], span.error])
          .sort(),
      ).toEqual([
        ['failed', true],
        ['skipped', false],
      ]);
    } finally {
      useTracer(before);
    }
  });

  test('is none where the request was not recorded, outside a request, or where tracing is off: the row carries nothing', async () => {
    const before = tracingOn(0);
    try {
      const unrecorded = await aWorkspaceRow(cloned.db);
      const request = tracer().start('request');
      expect(request.recording).toBe(false);
      // The HTTP hook gives the scope no span for a trace that is not recorded.
      await publishIn(unrecorded, undefined);
      expect(await traceOf(unrecorded)).toBeNull();
      useTracer(noTracer);
      const off = await aWorkspaceRow(cloned.db);
      await publishIn(off, undefined);
      expect(await traceOf(off)).toBeNull();
    } finally {
      useTracer(before);
    }
  });

  test('is a trace of its own for a delivery whose row has none, so a worker’s fact is still seen', async () => {
    const before = tracingOn();
    try {
      const workspaceId = await aWorkspaceRow(cloned.db);
      await publishIn(workspaceId, undefined);
      await drain(delivers);
      const delivery = ended.find((span) => span.name === 'fact.deliver');
      expect(delivery?.parentSpanId).toBeUndefined();
      expect(delivery?.traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      useTracer(before);
    }
  });

  test('makes no span where tracing is off, and the delivery is as it was', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publishIn(workspaceId, undefined);
    await drain(delivers);
    expect(ended).toEqual([]);
    const row = await cloned.db
      .selectFrom('outbox')
      .select('state')
      .where('workspace_id', '=', workspaceId)
      .where('consumer', '=', 'wiki')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('delivered');
  });

  test('the table refuses a trace that is not the shape the wire has, so a delivery never reads a malformed one', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await publishIn(workspaceId, undefined);
    const refused =
      await sql`update outbox set traceparent = 'not-a-trace' where workspace_id = ${workspaceId}`
        .execute(cloned.db)
        .then(
          () => 'taken',
          () => 'refused',
        );
    expect(refused).toBe('refused');
  });
});
