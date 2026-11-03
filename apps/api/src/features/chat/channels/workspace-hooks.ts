/**
 * What chat does when a workspace is made (D-174, D-250): its first channel, made as the creator would make
 * one — through the guard their new membership now passes, in the workspace's own transaction, on the trail as
 * `channel.created` — so it is an ordinary channel from its first moment and a workspace never exists
 * without it. Registered where the application is put together; the workspace code names no channel.
 */
import { DEFAULT_CHANNEL_NAME } from '@purlay/types';
import { hookList, type HookList } from '../../../platform/hooks';
import type { WorkspaceCreated } from '../../../modules/workspaces/workspaces';
import { createChannel } from './channels';

/** The hooks chat registers on a new workspace, in a list ready to hand to the code that makes one. */
export const chatWorkspaceHooks = (): HookList<Parameters<WorkspaceCreated['run']>> => {
  const hooks = hookList<Parameters<WorkspaceCreated['run']>>();
  hooks.register(async (transaction, clock, context) => {
    await createChannel(transaction, clock, context, { name: DEFAULT_CHANNEL_NAME });
  });
  return hooks;
};
