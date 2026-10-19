/**
 * Follow, in the thread panel's header (D-161, `UX.md` §4.2): whether the person is told of new
 * replies in this thread. Somebody who started or answered a thread follows it until they say
 * otherwise; anybody else can follow it to be told without writing in it.
 *
 * **A toggle with one name.** It is always "Follow", and `aria-pressed` says whether it is on — a
 * bell when it is, the struck bell the sidebar uses for a muted channel when it is not — while its
 * tooltip says what pressing it now would do, in Slack's words ("Turn off notifications for
 * replies"), as the other toggles' do (`icon-button.tsx`).
 *
 * **Painted at once** (CONTRIBUTING §1.9): the state changes before the server answers, a refusal
 * puts it back and says why, with Retry when trying again could help. Clicks go to the server one
 * after another, so the last one is what stays. Until the state is read the control is there and
 * disabled, so the header does not move when it arrives; if it could not be read, pressing it reads
 * it again.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ThreadFollow } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { isTransient } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useThreadFollow } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Tooltip } from '../../ui/tooltip';
import { useToast } from '../../ui/toast';

/** Each thread's follow requests, one after another, per client: the last click is what stays. */
const lines = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/** Follow a thread or let it go: painted at once, put back when refused. */
const useSetThreadFollow = (rootId: string): ((following: boolean) => void) => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const key = keys.threadFollow(rootId);

  const set = (following: boolean): void => {
    const before = client.getQueryData<ThreadFollow>(key);
    // A read already on its way would land after this paint and take it back: let it go.
    void client.cancelQueries({ queryKey: key });
    client.setQueryData<ThreadFollow>(key, { following });
    const line = lines.get(client) ?? new Map<string, Promise<void>>();
    lines.set(client, line);
    const after = line.get(rootId) ?? Promise.resolve();
    const done = after
      .then(() => api.setThreadFollow(rootId, following))
      .then(
        (answer) => {
          client.setQueryData<ThreadFollow>(key, answer);
        },
        (failure: unknown) => {
          if (before !== undefined) client.setQueryData<ThreadFollow>(key, before);
          show({
            message: `${t(following ? 'thread.follow.failed' : 'thread.follow.unfollowFailed')} ${describe(failure)}`,
            ...(isTransient(failure)
              ? {
                  actionLabel: t('common.retry'),
                  // Asks again for what was asked, only if it is still not so.
                  onAction: (): void => {
                    if (client.getQueryData<ThreadFollow>(key)?.following !== following) {
                      set(following);
                    }
                  },
                }
              : {}),
          });
        },
      )
      .finally(() => {
        if (line.get(rootId) === done) line.delete(rootId);
      });
    line.set(rootId, done);
  };
  return set;
};

export interface FollowToggleProps {
  readonly rootId: string;
  /**
   * How many live replies the person has in the thread. Answering a thread one had made no choice
   * about follows it (D-29), so when this grows the state is read again rather than guessed.
   */
  readonly repliedByMe: number;
}

export const FollowToggle = ({ rootId, repliedByMe }: FollowToggleProps): React.JSX.Element => {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useThreadFollow(rootId);
  const set = useSetThreadFollow(rootId);

  const replied = useRef(repliedByMe);
  useEffect(() => {
    if (repliedByMe > replied.current) {
      void client.invalidateQueries({ queryKey: keys.threadFollow(rootId) });
    }
    replied.current = repliedByMe;
  }, [client, repliedByMe, rootId]);

  const following = query.data?.following;
  const failed = query.isError && following === undefined;
  const tooltip = failed
    ? t('thread.follow.error')
    : following === true
      ? t('thread.follow.off')
      : t('thread.follow.on');

  return (
    <Tooltip content={tooltip}>
      <Button
        variant="ghost"
        glyph={following === true ? 'notifications' : 'deep-work'}
        aria-pressed={following ?? false}
        disabled={following === undefined && !failed}
        className={cn(following === true && 'text-accent-text hover:text-accent-text')}
        onClick={() => {
          if (following === undefined) {
            void query.refetch();
            return;
          }
          set(!following);
        }}
      >
        {t('thread.follow.label')}
      </Button>
    </Tooltip>
  );
};
