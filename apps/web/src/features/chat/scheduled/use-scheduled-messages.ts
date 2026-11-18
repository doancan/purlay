/** The caller's own scheduled messages in this workspace: the one read the tab, its count and the screen's lazy list share. */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ScheduledMessageList } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';

/** The caller's scheduled messages, read again when the window is focused and whenever the tab is opened. */
export const useScheduledMessages = (enabled: boolean): UseQueryResult<ScheduledMessageList> => {
  const api = useApi();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  return useQuery({
    queryKey: keys.scheduled(workspace.id, user.id),
    queryFn: ({ signal }) => api.listScheduledMessages(workspace.id, signal),
    enabled,
    // The server has no push for it: a list is as old as the last time it was asked for.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });
};
