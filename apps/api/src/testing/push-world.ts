/**
 * A workspace with two people, a notification sink of a module of the test's own, and a device to push to: what the
 * push sender's tests share (`sender-inbox.integration.test.ts`, `devices.integration.test.ts`).
 */
import { type Executor, type Transaction } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { NO_LOG, type EventBus } from '../platform/events';
import { serverMetrics } from '../platform/metrics';
import type { WrittenNotice } from '../platform/ports/notification-sink';
import { requireWorkspaceMembership } from '../platform/tenancy';
import { NOW } from './doubles';
import { KEYS } from './push-service';
import { aSession } from './signed-in';
import { aUniqueSlug, aUserRow } from './users';
import { notificationSink } from '../modules/inbox/sink';
import type { NoticeWords } from '../modules/push/notices';

export const KIND = 'thing_assigned';
/** The words of a module of the test's own: its title is in the params, and must never reach a device. */
export const words: NoticeWords = (kind, locale, actor) =>
  kind === KIND
    ? {
        body: locale === 'tr' ? `${actor} sana bir şey atadı` : `${actor} assigned you a thing`,
        path: 'things',
      }
    : undefined;

/** A clock the test moves. */
export const movable = (start: Date): Clock & { to: (instant: Date) => void } => {
  let current = start;
  return {
    now: (): Date => new Date(current),
    to: (instant): void => {
      current = instant;
    },
  };
};

const quietBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

export interface World {
  readonly clock: ReturnType<typeof movable>;
  readonly workspaceId: string;
  readonly ada: string;
  readonly bob: string;
  readonly write: (recipient: string, title?: string) => Promise<WrittenNotice>;
}

export const aWorld = async (db: Transaction): Promise<World> => {
  const clock = movable(NOW);
  const workspaceId = (
    await db
      .insertInto('workspaces')
      .values({ name: 'Studio', slug: aUniqueSlug('studio') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const member = async (name: string): Promise<string> => {
    const { userId } = await aUserRow(db, name);
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
      .execute();
    return userId;
  };
  const ada = await member('ada');
  const bob = await member('bob');
  const sink = notificationSink({
    module: 'things',
    clock,
    kinds: new Map([[KIND, 'things']]),
    bus: quietBus,
    log: NO_LOG,
    written: serverMetrics(undefined, ['things'], [], [{ module: 'things', kind: KIND }])
      .inboxEntries,
    collapsed: serverMetrics(undefined, ['things'], [], [{ module: 'things', kind: KIND }])
      .inboxCollapsed,
    pushedKinds: new Set([KIND]),
  });
  const context = await requireWorkspaceMembership(db, bob, workspaceId);
  return {
    clock,
    workspaceId,
    ada,
    bob,
    write: async (recipient, title = 'The secret plan'): Promise<WrittenNotice> => {
      clock.to(new Date(clock.now().getTime() + 1));
      const written = await sink.notify(db, context, {
        kind: KIND,
        recipientId: recipient,
        subject: { type: 'thing', id: crypto.randomUUID() },
        params: { title },
      });
      if (written === undefined) throw new Error('nothing was written');
      return written;
    },
  };
};

export const subscribe = async (
  db: Executor,
  clock: Clock,
  userId: string,
  browser: { p256dh: string; auth: string },
): Promise<void> => {
  const { sessionId } = await aSession(db, clock, userId, 30);
  await db
    .insertInto('push_subscriptions')
    .values({
      user_id: userId,
      session_id: sessionId,
      endpoint: `https://push.example.com/send/${userId}`,
      p256dh: browser.p256dh,
      auth: browser.auth,
      server_key: KEYS.publicKey,
      failures: 0,
      created_at: new Date(clock.now().getTime() - 60_000),
    })
    .execute();
};
