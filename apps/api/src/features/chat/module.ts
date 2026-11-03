/**
 * Chat, as a module (D-250, `MODULES.md` §2): its manifest and everything it contributes to the places the core
 * leaves open — what a new workspace starts with, what an erased person's account forgets, who answers for a
 * workspace's channels, what a deleted workspace's purge takes, what an export holds, and the columns readiness
 * checks. Nothing in the core names any of it: the composition root (`composition.ts`) reads this object when chat
 * is among the modules a process runs, and leaves it out when it is not.
 */
import { chatExport } from './export';
import { chatPersonalExport } from './personal-export';
import { startWithTheDefaultChannel } from './channels/workspace-hooks';
import { forgetWhatChatKeeps } from './channels/user-hooks';
import { chatWorkspaceChannels } from './channels/workspace-channels';
import { CHAT_COLLATED_COLUMNS } from './collated-columns';
import { chatWorkspacePurge } from './messages/workspace-purge';

export const chatModule = {
  // Its tables are in the core's first migrations (`MODULES.md` §5): they exist with chat off.
  dataInCore: true,
  manifest: {
    id: 'chat',
    requires: [],
    optional: [],
    provides: [],
    // Every route that is about channels, messages and what hangs off them. The ones that are the workspace's own
    // (its members, invitations, exports, retention window, deletion, uploads) and the account's are the core's, and
    // `routes.test.ts` of the door holds the two lists to the routes the application registers.
    // Only what acts for chat's users. The sweeps and the retention purge keep the rows tidy and keep running whether
    // chat does or not: the rows are there.
    jobs: ['mail:missed'],
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
      '/api/workspaces/:workspaceId/archived-channels',
      '/api/workspaces/:workspaceId/conversations',
      '/api/workspaces/:workspaceId/dms',
      '/api/workspaces/:workspaceId/github-app',
      '/api/workspaces/:workspaceId/github-app/installation',
      '/api/workspaces/:workspaceId/github-repositories',
      '/api/workspaces/:workspaceId/integrations/github',
      '/api/workspaces/:workspaceId/presence',
      '/api/workspaces/:workspaceId/read',
      '/api/workspaces/:workspaceId/saved',
      '/api/workspaces/:workspaceId/saved/ids',
      '/api/workspaces/:workspaceId/saved-searches',
      '/api/workspaces/:workspaceId/saved-searches/:searchId',
      '/api/workspaces/:workspaceId/search',
      '/api/workspaces/:workspaceId/unresolved',
    ],
  },
  workspaceCreated: startWithTheDefaultChannel,
  userErased: forgetWhatChatKeeps,
  workspaceChannels: chatWorkspaceChannels,
  workspacePurge: chatWorkspacePurge,
  export: chatExport,
  personalExport: chatPersonalExport,
  collatedColumns: CHAT_COLLATED_COLUMNS,
};
