// Scheduled messages ("Send later"): the caller's own drafts held until a chosen time.
import {
  Message,
  ScheduledMessage,
  ScheduledMessageList,
  type ScheduleMessageRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface ScheduledApi {
  /** The caller's pending and failed scheduled messages in a workspace, by send time; the server holds at most 100. */
  readonly listScheduledMessages: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<ScheduledMessageList>;
  /** Creates or replaces one under the id the client chose, so a retry is the same draft. */
  readonly scheduleMessage: (
    channelId: string,
    scheduledId: string,
    input: ScheduleMessageRequest,
  ) => Promise<ScheduledMessage>;
  /**
   * Sends one at once, as the server would have at its time, and answers the message; one already sent — by a second
   * press or by the server's own delivery — is `SCHEDULED_MESSAGE_SENT`, so asking again never sends twice.
   */
  readonly sendScheduledMessage: (channelId: string, scheduledId: string) => Promise<Message>;
  /** Cancels one that has not been sent; one already sent is `SCHEDULED_MESSAGE_SENT`. */
  readonly cancelScheduledMessage: (channelId: string, scheduledId: string) => Promise<void>;
}

export const createScheduledApi = (http: Http): ScheduledApi => ({
  listScheduledMessages: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/scheduled`,
      ScheduledMessageList,
      options({}, signal),
    ),
  scheduleMessage: (channelId, scheduledId, input) =>
    http.request(
      'PUT',
      `/api/channels/${at(channelId)}/scheduled/${at(scheduledId)}`,
      ScheduledMessage,
      options({ activity: true, body: input }),
    ),
  sendScheduledMessage: (channelId, scheduledId) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/scheduled/${at(scheduledId)}/send`,
      Message,
      options({ activity: true }),
    ),
  cancelScheduledMessage: (channelId, scheduledId) =>
    http.send(
      'DELETE',
      `/api/channels/${at(channelId)}/scheduled/${at(scheduledId)}`,
      options({ activity: true }),
    ),
});
