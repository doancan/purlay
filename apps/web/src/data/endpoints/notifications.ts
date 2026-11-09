// What the caller is told and how: the inbox, push, quiet hours and missed-mail letters.
import {
  InboxPage,
  MissedMailSetting,
  NotificationPage,
  PushKeyResponse,
  QuietHoursSetting,
  type InboxQuery,
  type MarkInboxReadRequest,
  type NotificationQuery,
  type PushLocale,
  type PushSubscribeRequest,
  type ReadNotificationsRequest,
  type SetMissedMailRequest,
  type SetQuietHoursRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface NotificationsApi {
  /** The caller's inbox in one workspace, newest first (D-106). */
  readonly notifications: (
    workspaceId: string,
    page?: Omit<NotificationQuery, 'workspaceId' | 'before'> & {
      readonly before?: NotificationQuery['before'];
    },
    signal?: AbortSignal,
  ) => Promise<NotificationPage>;
  /** What the workspace's modules told the caller, newest first: the Updates section (D-286). */
  readonly inbox: (
    workspaceId: string,
    page?: Pick<InboxQuery, 'before' | 'limit' | 'unreadOnly'>,
    signal?: AbortSignal,
  ) => Promise<InboxPage>;
  /** Reads these updates, or every one the caller has in the workspace (D-286). */
  readonly readInbox: (workspaceId: string, input: MarkInboxReadRequest) => Promise<void>;
  /** Marks the caller's notifications read: these, or a workspace's up to `before` (D-106). */
  readonly readNotifications: (input: ReadNotificationsRequest) => Promise<void>;
  /** The server's push key; `PUSH_UNAVAILABLE` where the operator has not switched push on (D-126). */
  readonly pushKey: (signal?: AbortSignal) => Promise<PushKeyResponse>;
  readonly subscribePush: (input: PushSubscribeRequest) => Promise<void>;
  readonly unsubscribePush: (endpoint: string) => Promise<void>;
  /** The language the server writes this person's notifications in. */
  readonly setLocale: (locale: PushLocale) => Promise<void>;
  /** The caller's quiet hours and the profile's time zone they are read in (D-234). */
  readonly quietHours: (signal?: AbortSignal) => Promise<QuietHoursSetting>;
  readonly setQuietHours: (input: SetQuietHoursRequest) => Promise<QuietHoursSetting>;
  /** Whether the caller is emailed about what they missed, and whether it can be offered (D-240). */
  readonly missedMail: (signal?: AbortSignal) => Promise<MissedMailSetting>;
  readonly setMissedMail: (input: SetMissedMailRequest) => Promise<MissedMailSetting>;
  /** A letter's stop link, spent without a session (D-240). */
  readonly stopMissedMail: (token: string) => Promise<void>;
}

export const createNotificationsApi = (http: Http): NotificationsApi => ({
  notifications: (workspaceId, page = {}, signal) =>
    http.request(
      'GET',
      '/api/notifications',
      NotificationPage,
      options(
        {
          query: {
            workspaceId,
            before: page.before,
            types: page.types,
            limit: page.limit,
            // The server reads it as text; absent is everything (D-106).
            ...(page.unreadOnly === true ? { unreadOnly: 'true' } : {}),
          },
        },
        signal,
      ),
    ),
  inbox: (workspaceId, page = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/inbox`,
      InboxPage,
      options(
        {
          query: {
            before: page.before,
            limit: page.limit,
            ...(page.unreadOnly === true ? { unreadOnly: 'true' } : {}),
          },
        },
        signal,
      ),
    ),
  readInbox: (workspaceId, input) =>
    http.send('POST', `/api/workspaces/${at(workspaceId)}/inbox/read`, options({ body: input })),
  readNotifications: (input) =>
    http.send('PUT', '/api/notifications/read', options({ body: input })),
  pushKey: (signal) => http.request('GET', '/api/push/key', PushKeyResponse, options({}, signal)),
  subscribePush: (input) => http.send('POST', '/api/push/subscriptions', options({ body: input })),
  unsubscribePush: (endpoint) =>
    http.send('POST', '/api/push/subscriptions/remove', options({ body: { endpoint } })),
  setLocale: (locale) => http.send('PUT', '/api/me/locale', options({ body: { locale } })),
  quietHours: (signal) =>
    http.request('GET', '/api/me/quiet-hours', QuietHoursSetting, options({}, signal)),
  setQuietHours: (input) =>
    http.request('PUT', '/api/me/quiet-hours', QuietHoursSetting, options({ body: input })),
  missedMail: (signal) =>
    http.request('GET', '/api/me/missed-mail', MissedMailSetting, options({}, signal)),
  setMissedMail: (input) =>
    http.request('PUT', '/api/me/missed-mail', MissedMailSetting, options({ body: input })),
  stopMissedMail: (token) =>
    http.send('POST', '/api/missed-mail/stop', options({ body: { token } })),
});
