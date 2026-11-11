/** Guest reads and accepted receipts share the existing member cache and retain known results after refresh errors. */
import { useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type {
  WorkspaceGuestPage,
  UpdatedGuestAccess,
  UpdateGuestAccessRequest,
  WorkspaceMemberList,
  WorkspaceMember,
} from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { isApiError, isUnconfirmedMutation } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { useWorkspace } from '../shell/workspace';

type ActionResult = { readonly ok: true } | { readonly ok: false; readonly problem: string };
interface GuestDirectory {
  readonly list: UseInfiniteQueryResult<InfiniteData<WorkspaceGuestPage>>;
  readonly notice: string | null;
  search(value: string): void;
  retry(): Promise<void>;
  edit(userId: string, input: UpdateGuestAccessRequest): Promise<ActionResult>;
  remove(userId: string): Promise<ActionResult>;
  convert(userId: string): Promise<ActionResult>;
}

export const useGuestDirectory = (onRemoved: () => void): GuestDirectory => {
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const list = useInfiniteQuery({
    queryKey: keys.guests(workspace.id, search),
    queryFn: async ({ pageParam, signal }) =>
      await api.guests(
        workspace.id,
        {
          ...(search === '' ? {} : { q: search }),
          ...(pageParam === undefined ? {} : { before: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const refresh = async (): Promise<boolean> => {
    try {
      await list.refetch({ throwOnError: true });
      return true;
    } catch {
      return false;
    }
  };
  const refusal = async (
    failure: unknown,
  ): Promise<Extract<ActionResult, { readonly ok: false }>> => {
    const unconfirmed = isUnconfirmedMutation(failure);
    if (unconfirmed && alive.current) await refresh();
    const detail = isApiError(failure)
      ? (failure.fields['channelIds'] ?? failure.fields['accessExpiresAt'] ?? describe(failure))
      : describe(failure);
    return { ok: false, problem: unconfirmed ? `${t('guests.unconfirmed')} ${detail}` : detail };
  };
  const reconcile = async (
    userId: string,
    receipt: UpdatedGuestAccess | null,
    converted?: WorkspaceMember,
  ): Promise<boolean> => {
    await client.cancelQueries({ queryKey: keys.guests(workspace.id) });
    client.setQueriesData<InfiniteData<WorkspaceGuestPage>>(
      { queryKey: keys.guests(workspace.id) },
      (previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                data:
                  receipt === null
                    ? page.data.filter((row) => row.user.id !== userId)
                    : page.data.map((row) =>
                        row.user.id === userId ? { ...row, ...receipt } : row,
                      ),
              })),
            },
    );
    if (receipt === null) {
      await client.cancelQueries({ queryKey: keys.members(workspace.id), exact: true });
      client.setQueryData<WorkspaceMemberList>(keys.members(workspace.id), (previous) =>
        previous === undefined
          ? undefined
          : converted === undefined
            ? previous.filter((row) => row.user.id !== userId)
            : [...previous.filter((row) => row.user.id !== userId), converted],
      );
    }
    if (converted !== undefined)
      await client.invalidateQueries({ queryKey: keys.members(workspace.id), exact: true });
    await client.invalidateQueries({ queryKey: keys.guests(workspace.id), refetchType: 'none' });
    if (!alive.current) return true;
    return await refresh();
  };
  return {
    list,
    notice,
    search: (value): void => {
      setNotice(null);
      setSearch(value.trim());
    },
    retry: async (): Promise<void> => {
      if (await refresh()) setNotice(null);
    },
    edit: async (userId, input): Promise<ActionResult> => {
      let receipt: UpdatedGuestAccess;
      try {
        receipt = await api.updateGuestAccess(workspace.id, userId, input);
      } catch (failure) {
        return await refusal(failure);
      }
      const refreshed = await reconcile(userId, receipt);
      if (alive.current) setNotice(t(refreshed ? 'guests.saved' : 'guests.savedReadFailed'));
      return { ok: true };
    },
    convert: async (userId): Promise<ActionResult> => {
      let receipt: WorkspaceMember;
      try {
        receipt = await api.convertGuest(workspace.id, userId, { confirmFullAccess: true });
      } catch (failure) {
        const result = await refusal(failure);
        if (isUnconfirmedMutation(failure) && alive.current) {
          await client.invalidateQueries({ queryKey: keys.members(workspace.id), exact: true });
          const observed = client.getQueryData<InfiniteData<WorkspaceGuestPage>>(
            keys.guests(workspace.id, search),
          );
          if (
            observed?.pages.every((page) => page.data.every((row) => row.user.id !== userId)) ===
            true
          ) {
            setNotice(result.problem);
            onRemoved();
          }
        }
        return result;
      }
      const refreshed = await reconcile(userId, null, receipt);
      if (alive.current) {
        setNotice(t(refreshed ? 'guests.converted' : 'guests.convertedReadFailed'));
        onRemoved();
      }
      return { ok: true };
    },
    remove: async (userId): Promise<ActionResult> => {
      try {
        await api.removeMember(workspace.id, userId);
      } catch (failure) {
        return await refusal(failure);
      }
      const refreshed = await reconcile(userId, null);
      if (alive.current) {
        setNotice(t(refreshed ? 'guests.removed' : 'guests.removedReadFailed'));
        onRemoved();
      }
      return { ok: true };
    },
  };
};
