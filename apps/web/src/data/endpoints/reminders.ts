// Being told about a message again: a person's own reminders (`API.md` "Message reminders").
import { MessageReminder, MessageReminderList } from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface RemindersApi {
  /** The caller's pending reminders in a workspace, the soonest first. */
  readonly listReminders: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<MessageReminderList>;
  /** Sets the caller's reminder on a message, or replaces the one it has. */
  readonly setMessageReminder: (messageId: string, remindAt: string) => Promise<MessageReminder>;
  /** Cancels it; a message with none is not an error. */
  readonly cancelMessageReminder: (messageId: string) => Promise<void>;
}

export const createRemindersApi = (http: Http): RemindersApi => ({
  listReminders: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/reminders`,
      MessageReminderList,
      options({}, signal),
    ),
  setMessageReminder: (messageId, remindAt) =>
    http.request(
      'PUT',
      `/api/messages/${at(messageId)}/reminder`,
      MessageReminder,
      options({ body: { remindAt } }),
    ),
  cancelMessageReminder: (messageId) =>
    http.send('DELETE', `/api/messages/${at(messageId)}/reminder`, options()),
});
