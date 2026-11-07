/**
 * Chat, as a module (D-250, `MODULES.md` §2): its manifest and everything it contributes to the places the core
 * leaves open — what a new workspace starts with, what an erased person's account forgets, who answers for a
 * workspace's channels, what a deleted workspace's purge takes, what an export holds, and the columns readiness
 * checks. Nothing in the core names any of it: the composition root (`composition.ts`) reads this object when chat
 * is among the modules a process runs, and leaves it out when it is not.
 */
import { CHAT_AUDIT_ACTIONS, CHAT_NOTIFICATION_KINDS, type ServerEvent } from '@purlay/types';
import { chatBudget } from './budget';
import { chatFrameHandlers } from './frames';
import { chatExport } from './export';
import { chatPersonalExport } from './personal-export';
import { startWithTheDefaultChannel } from './channels/workspace-hooks';
import { forgetWhatChatKeeps } from './channels/user-hooks';
import { requireAttachmentById } from './channels/guard';
import { chatWorkspaceChannels } from './channels/workspace-channels';
import { CHAT_COLLATED_COLUMNS } from './collated-columns';
import { chatRoutes } from './http/routes';
import { chatJobWork } from './jobs';
import { chatWorkers } from './workers';
import { chatPushNotices } from './notifications/push-notices';
import { chatWorkspacePurge } from './messages/workspace-purge';

export const chatModule = {
  manifest: {
    id: 'chat',
    requires: [],
    optional: [],
    provides: [],
    // What the modules may take of the pool together, less a connection for the next: the core keeps its own reserve
    // (`budget.ts`, `MODULES.md` §7, `budget:latency` holds chat's p95 against a busy issues module).
    budget: { poolShare: chatBudget },
    // Every route that is about channels, messages and what hangs off them. The ones that are the workspace's own
    // (its members, invitations, exports, retention window, deletion, uploads) and the account's are the core's, and
    // `routes.test.ts` of the door holds the two lists to the routes the application registers.
    // Only what acts for chat's users.
    jobs: ['mail:missed'],
    // What keeps the rows within their retention keeps running whether chat does or not: the rows are there.
    retention: ['purge:retention', 'sweep:link-previews', 'sweep:github-deliveries'],
    // What a person does in a channel over the socket: watch it, write in it, say they are typing.
    frames: ['SUBSCRIBE', 'UNSUBSCRIBE', 'MESSAGE_SEND', 'TYPING'],
    // What chat's services send to a socket. The core's own — a workspace changing, an access revoked, a session
    // ended, the acknowledgements, the pong — are not listed, nor is deep work's: they reach every process.
    events: [
      'MESSAGE_CREATED',
      'MESSAGE_HIDDEN',
      'MESSAGE_REVISED',
      'MESSAGE_VERSIONS_UPDATED',
      'THREAD_UPDATED',
      'REACTIONS_UPDATED',
      'CHANNEL_STATE',
      'CHANNEL_ADDED',
      'CHANNEL_UPDATED',
      'CHANNELS_UPDATED',
      'PINS_UPDATED',
      'BOOKMARKS_UPDATED',
      'INCIDENT_UPDATED',
      'REMINDERS_UPDATED',
      'SAVED_UPDATED',
      'NOTIFICATIONS_UPDATED',
      'TYPING',
      'PRESENCE',
    ] satisfies readonly ServerEvent[],
    auditActions: [{ read: 'audit.read', actions: CHAT_AUDIT_ACTIONS }],
    // What a message tells a person, and what a search of the workspace reads: both are chat's.
    notifications: CHAT_NOTIFICATION_KINDS,
    searchSources: ['messages'],
    routes: [
      '/api/channels/**',
      '/api/messages/**',
      '/api/notifications',
      '/api/notifications/read',
      '/api/missed-mail/stop',
      '/api/webhooks/**',
      '/api/github-app/**',
      '/api/integrations/**',
      '/api/workspaces/:workspaceId/channels',
      '/api/workspaces/:workspaceId/channel-groups',
      '/api/workspaces/:workspaceId/channel-groups/:groupId',
      '/api/workspaces/:workspaceId/archived-channels',
      '/api/workspaces/:workspaceId/conversations',
      '/api/workspaces/:workspaceId/dms',
      '/api/workspaces/:workspaceId/github-app',
      '/api/workspaces/:workspaceId/github-app/installation',
      '/api/workspaces/:workspaceId/github-repositories',
      '/api/workspaces/:workspaceId/integrations/github',
      '/api/workspaces/:workspaceId/presence',
      '/api/workspaces/:workspaceId/read',
      '/api/workspaces/:workspaceId/reminders',
      '/api/workspaces/:workspaceId/saved',
      '/api/workspaces/:workspaceId/saved/ids',
      '/api/workspaces/:workspaceId/saved-searches',
      '/api/workspaces/:workspaceId/saved-searches/:searchId',
      '/api/workspaces/:workspaceId/scheduled',
      '/api/workspaces/:workspaceId/search',
      '/api/workspaces/:workspaceId/unresolved',
    ],
  },
  // A file attached to a message is chat's: it is read through the channel the message is in.
  readAttachment: requireAttachmentById,
  // What a message told, for the push sender: the notifications are chat's.
  pushNotices: chatPushNotices,
  workspaceCreated: startWithTheDefaultChannel,
  userErased: forgetWhatChatKeeps,
  workspaceChannels: chatWorkspaceChannels,
  workspacePurge: chatWorkspacePurge,
  export: chatExport,
  personalExport: chatPersonalExport,
  collatedColumns: CHAT_COLLATED_COLUMNS,
  // The work of `jobs` and `retention` above.
  jobWork: chatJobWork,
  // Scheduled messages and reminders are delivered by the process that runs chat, and by no other (D-250).
  workers: chatWorkers,
  // What the router asks of chat for the operations of `frames` above that it has moved here (`MODULES.md` §9).
  frameHandlers: chatFrameHandlers,
  // All of chat's routes (D-280): `features/chat/http/routes.ts`.
  routes: chatRoutes,
};
