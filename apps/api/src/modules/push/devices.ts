/**
 * Choosing the devices a notice goes to (#78, D-126, D-143, D-286 §9): the live devices of the people it
 * told, whose subscription was made with the server's current key, minus the people in front of the
 * workspace's page (D-143), and — for a module's notice — minus those in Deep Work or their quiet hours,
 * whose notices wait instead. What each device is told is worded here, in the person's language.
 */
import { sql, type Executor } from '@purlay/db';
import { companySessionAllowsWorkspace } from '../../platform/company-session';
import { NEEDS_YOU, type PushLocale, type PushPayload } from '@purlay/types';
import type { Attention } from '../../platform/attention';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { inDeepWork } from '../workspaces/deep-work';
import type { NoticeWords, PushNotices } from './notices';
import type { VapidKeys } from './vapid';
import { pushBody, saidOf } from './words';

/** The server's push keys, or where to ask for them when an administrator can change them while the server runs. */
export type PushKeys = VapidKeys | (() => Promise<VapidKeys | undefined>);

interface Subscription {
  readonly companyWorkspaceId: string | null;
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly locale: string;
  readonly serverKey: string;
  readonly generation: string;
}

export interface Device extends Omit<Subscription, 'locale' | 'companyWorkspaceId'> {
  readonly workspaceId: string;
  readonly source:
    { readonly messageId: string; readonly notificationId?: string } | { readonly entryId: string };
  readonly payload: PushPayload;
  /** The module whose notice this is, for the failure counter's label; absent, the sender's owner (chat's messages). */
  readonly module?: string;
}

interface SubscriptionLookup {
  readonly database: Executor;
  readonly clock: Clock;
  readonly keys: PushKeys;
}

export interface DeviceFinder extends SubscriptionLookup {
  readonly log: Logger;
  readonly attention: Attention;
  readonly notices: PushNotices;
  readonly noticeWords: NoticeWords;
}

/** Where inbox entries stand for a push: the devices to tell now, and the entries that wait for Deep Work or quiet hours to end. */
interface Routed {
  readonly devices: Device[];
  readonly waiting: ReadonlySet<string>;
}

/** The live devices of these people whose subscription was made with the server's current key, in the order they were made. */
const subscriptionsOf = async (
  { database, clock, keys }: SubscriptionLookup,
  userIds: readonly string[],
): Promise<Subscription[]> => {
  const current = typeof keys === 'function' ? await keys() : keys;
  if (current === undefined) return [];
  return await database
    .selectFrom('push_subscriptions as s')
    .innerJoin('users as person', 'person.id', 's.user_id')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    .select([
      's.id',
      's.generation',
      's.server_key as serverKey',
      's.user_id as userId',
      's.session_id as sessionId',
      'live.company_workspace_id as companyWorkspaceId',
      's.endpoint',
      's.p256dh',
      's.auth',
      'person.locale',
    ])
    .where('s.user_id', 'in', userIds)
    .whereRef('live.user_id', '=', 's.user_id')
    .where('person.deleted_at', 'is', null)
    .where('person.suspended_at', 'is', null)
    .where('live.expires_at', '>', clock.now())
    .where(companySessionAllowsWorkspace('live', sql<string>`live.company_workspace_id`))
    .where('s.server_key', '=', current.publicKey)
    // A person's devices in the order they were subscribed: the same order every time.
    .orderBy('s.created_at')
    .orderBy('s.id')
    .execute();
};

const localeOf = (locale: string): PushLocale => (locale === 'tr' ? 'tr' : 'en');

/** The devices of the people a message told, with what each is to be told. */
export const devicesFor = async (
  dependencies: DeviceFinder,
  messageId: string,
  userIds: readonly string[],
  notificationId?: string,
): Promise<Device[]> => {
  const { database, attention, log, notices } = dependencies;
  const told = await notices.of(database, messageId, userIds, notificationId);
  if (told.length === 0) return [];
  const subscriptions = await subscriptionsOf(dependencies, [
    ...new Set(told.map((notice) => notice.userId)),
  ]);
  const workspaces = await database
    .selectFrom('workspaces')
    .select(['id', 'slug'])
    .where('id', 'in', [...new Set(told.map((notice) => notice.workspaceId))])
    .execute();
  const slugs = new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]));
  const rows = subscriptions.flatMap((subscription) =>
    told
      .filter(
        (notice) =>
          notice.userId === subscription.userId &&
          (subscription.companyWorkspaceId === null ||
            subscription.companyWorkspaceId === notice.workspaceId),
      )
      .flatMap((notice) => {
        const slug = slugs.get(notice.workspaceId);
        return slug === undefined ? [] : [{ ...subscription, ...notice, slug }];
      }),
  );
  const held = new Set<string>();
  const devices = rows.flatMap((row) => {
    const reason =
      row.type === 'reminder' ? 'reminder' : NEEDS_YOU.find((known) => known === row.type);
    if (reason === undefined) return [];
    // In front of this workspace's page: held, never sent later (D-143, D-12).
    if (attention.active(row.userId, row.workspaceId)) {
      held.add(row.userId);
      return [];
    }
    return [
      {
        ...row,
        source: { messageId, ...(notificationId === undefined ? {} : { notificationId }) },
        payload: {
          // A channel by its name; a group by its people; a direct message by who wrote it.
          title:
            row.channelName !== null ? `#${row.channelName}` : (row.groupNames ?? row.authorName),
          body: pushBody(
            localeOf(row.locale),
            saidOf(reason, row.groupNames !== null, row.rootSenderId, row.userId),
            row.authorName,
          ),
          url: `/w/${row.slug}/c/${row.channelId}${row.threadId === null ? '' : `?thread=${encodeURIComponent(row.threadId)}`}`,
          tag: `channel:${row.channelId}`,
        },
      },
    ];
  });
  if (held.size > 0) log.debug('push held: the person is active', { messageId, people: held.size });
  return devices;
};

/** The devices to tell of these inbox entries now, and the entries whose person is in Deep Work or their quiet hours. */
export const routeInbox = async (
  dependencies: DeviceFinder,
  entryIds: readonly string[],
): Promise<Routed> => {
  const { database, clock, attention, log, noticeWords } = dependencies;
  const entries = await database
    .selectFrom('inbox_entries as e')
    .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
    .innerJoin('users as person', 'person.id', 'e.user_id')
    .leftJoin('users as actor', 'actor.id', 'e.actor_id')
    .select([
      'e.id',
      'e.user_id as userId',
      'e.workspace_id as workspaceId',
      'e.kind',
      'e.subject_id as subjectId',
      'w.slug',
      'w.name as workspaceName',
      'actor.display_name as actorName',
      'e.module',
    ])
    .where('e.id', 'in', entryIds)
    // What was read meanwhile, or whose person or workspace is gone, is not worth a push.
    .where('e.read_at', 'is', null)
    .where('w.deleted_at', 'is', null)
    .where('person.deleted_at', 'is', null)
    .where('person.suspended_at', 'is', null)
    .execute();
  if (entries.length === 0) return { devices: [], waiting: new Set() };
  const now = clock.now();
  const quiet = new Map<string, ReadonlySet<string>>();
  for (const workspaceId of new Set(entries.map((entry) => entry.workspaceId))) {
    quiet.set(
      workspaceId,
      await inDeepWork(
        database,
        workspaceId,
        [...new Set(entries.filter((e) => e.workspaceId === workspaceId).map((e) => e.userId))],
        now,
      ),
    );
  }
  const waiting = new Set(
    entries.filter((entry) => quiet.get(entry.workspaceId)?.has(entry.userId)).map((e) => e.id),
  );
  const ready = entries.filter(
    (entry) => !waiting.has(entry.id) && !attention.active(entry.userId, entry.workspaceId),
  );
  if (ready.length === 0) return { devices: [], waiting };
  const subscriptions = await subscriptionsOf(dependencies, [
    ...new Set(ready.map((entry) => entry.userId)),
  ]);
  const devices = subscriptions.flatMap((subscription) =>
    ready
      .filter(
        (entry) =>
          entry.userId === subscription.userId &&
          (subscription.companyWorkspaceId === null ||
            subscription.companyWorkspaceId === entry.workspaceId),
      )
      .flatMap((entry) => {
        const saying = noticeWords(
          entry.kind,
          localeOf(subscription.locale),
          entry.actorName ?? 'Purlay',
        );
        if (saying === undefined) {
          log.warn('push not sent: no words for the kind', { kind: entry.kind });
          return [];
        }
        return [
          {
            ...subscription,
            workspaceId: entry.workspaceId,
            source: { entryId: entry.id },
            module: entry.module,
            payload: {
              title: entry.workspaceName,
              body: saying.body,
              url: `/w/${entry.slug}/${saying.path}`,
              tag: `inbox:${entry.subjectId}`,
            },
          },
        ];
      }),
  );
  return { devices, waiting };
};
