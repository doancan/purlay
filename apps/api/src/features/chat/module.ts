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
  manifest: { id: 'chat', requires: [], optional: [], provides: [] },
  workspaceCreated: startWithTheDefaultChannel,
  userErased: forgetWhatChatKeeps,
  workspaceChannels: chatWorkspaceChannels,
  workspacePurge: chatWorkspacePurge,
  export: chatExport,
  personalExport: chatPersonalExport,
  collatedColumns: CHAT_COLLATED_COLUMNS,
};
