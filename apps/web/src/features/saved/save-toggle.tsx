/**
 * Save, beside React on a message (#484, D-128): a message kept to come back to, on any message one
 * can read. Painted at once — the mark changes before the server answers — and a refusal puts it back
 * and says why, with Retry, never a silent drop (CONTRIBUTING §1.9).
 *
 * Which messages are saved is one list for the workspace (`GET …/saved/ids`), read once and kept by
 * the cache; another tab's change arrives as `SAVED_UPDATED`, which reads it again.
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Message, SavedIds } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { useWorkspaceIfAny } from '../shell/workspace';

const idsKey = (workspaceId: string): readonly unknown[] => [...keys.saved(workspaceId), 'ids'];

/** Which messages the person has saved in the workspace. */
const useSavedIds = (workspaceId: string): UseQueryResult<SavedIds> => {
  const api = useApi();
  return useQuery({
    queryKey: idsKey(workspaceId),
    queryFn: ({ signal }) => api.savedIds(workspaceId, signal),
  });
};

/** Nothing outside a workspace: what is saved belongs to one. */
export const SaveToggle = ({
  message,
}: {
  readonly message: Message;
}): React.JSX.Element | null => {
  const scope = useWorkspaceIfAny();
  return scope === null ? null : <Toggle message={message} workspaceId={scope.workspace.id} />;
};

const Toggle = ({
  message,
  workspaceId,
}: {
  readonly message: Message;
  readonly workspaceId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const ids = useSavedIds(workspaceId);
  const saved = (ids.data ?? []).some((entry) => entry.messageId === message.id);

  const toggle = (): void => {
    const key = idsKey(workspaceId);
    const before = client.getQueryData<SavedIds>(key) ?? [];
    const keeping = !saved;
    client.setQueryData<SavedIds>(
      key,
      keeping
        ? [{ messageId: message.id, channelId: message.channelId, state: 'in_progress' }, ...before]
        : before.filter((entry) => entry.messageId !== message.id),
    );
    (keeping ? api.saveMessage(message.id) : api.unsaveMessage(message.id)).then(
      () => {
        // Every view of the saves is read again, the one listing this message included.
        void client.invalidateQueries({ queryKey: keys.saved(workspaceId) });
      },
      (failure: unknown) => {
        client.setQueryData<SavedIds>(key, before);
        show({
          message: `${t(keeping ? 'saved.failed' : 'saved.unsaveFailed')} ${describe(failure)}`,
          actionLabel: t('common.retry'),
          onAction: toggle,
        });
      },
    );
  };

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={t(saved ? 'saved.remove' : 'saved.save')}
      title={t(saved ? 'saved.remove' : 'saved.save')}
      className={cn(
        'inline-flex h-control aspect-square items-center justify-center rounded-sm hover:bg-surface-100',
        saved ? 'text-accent-text' : 'text-ink-muted hover:text-ink',
      )}
      onClick={toggle}
    >
      <Icon name={saved ? 'saved' : 'save'} />
    </button>
  );
};
