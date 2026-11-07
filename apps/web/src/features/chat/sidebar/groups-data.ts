/** The caller's bounded metadata read; editing is in the deferred sidebar chunk. */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChannelGroupPage } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';
import { useWorkspace } from '../../shell/workspace';

export const useChannelGroups = (): UseQueryResult<ChannelGroupPage> => {
  const api = useApi();
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: keys.channelGroups(workspace.id),
    queryFn: async ({ signal }) => await api.channelGroups(workspace.id, signal),
  });
};
