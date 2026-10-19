/**
 * Public channels the person is not in, each one click from joined — and each saying what it is
 * before it is joined (D-166): its name, its topic on one line, and how many people are in it. By
 * name (D-160); past a handful, a field narrows them by name and topic.
 *
 * Reads the same channel list the sidebar does, so a channel joined here leaves this list
 * and enters the sidebar in the same render with no second request. A join that fails says
 * so in a toast and leaves the row where it was; the person is never navigated into a
 * channel they are not in.
 */
import { useDescribeFailure } from '../../data/failure';
import { useState } from 'react';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { FINDABLE_FROM, TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { fold } from '../composer/mention-suggest';
import { useWorkspace } from '../shell/workspace';
import { joinableChannels } from './ordering';
import { SectionEmpty, SectionError, SectionLoading } from './section-state';

export const BrowseChannelsDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { joinChannel } = useActions();
  const { navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [joining, setJoining] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // A dialog opened again starts from every channel, not from the last search.
  const openChange = (next: boolean): void => {
    if (!next) setQuery('');
    onOpenChange(next);
  };

  const join = async (channelId: string): Promise<void> => {
    setJoining(channelId);
    try {
      await joinChannel(channelId);
      openChange(false);
      navigate(href('channel', { slug: workspace.slug, channelId }));
    } catch (failure) {
      show({ message: `${t('browse.joinFailed')} ${describe(failure)}` });
    } finally {
      setJoining(null);
    }
  };

  const joinable = joinableChannels(channels.data ?? []);
  const wanted = fold(query.trim());
  const shown =
    wanted === ''
      ? joinable
      : joinable.filter(
          (channel) =>
            fold(channel.name ?? '').includes(wanted) || fold(channel.topic ?? '').includes(wanted),
        );

  return (
    <Dialog
      open={open}
      onOpenChange={openChange}
      title={t('browse.title')}
      description={t('browse.description')}
      closeLabel={t('common.close')}
    >
      {channels.isPending ? (
        <SectionLoading flush label={t('browse.loading')} />
      ) : channels.isError ? (
        <SectionError
          flush
          title={t('browse.error.title')}
          body={t('browse.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void channels.refetch();
          }}
        />
      ) : joinable.length === 0 ? (
        <SectionEmpty flush title={t('browse.empty.title')} body={t('browse.empty.body')} />
      ) : (
        <>
          {joinable.length > FINDABLE_FROM && (
            <TextField
              label={t('browse.find')}
              type="search"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          )}
          {shown.length === 0 ? (
            <p role="status" className="text-body text-ink-muted">
              {t('browse.noMatch', { query: query.trim() })}
            </p>
          ) : (
            <ul className="flex max-h-screen flex-col gap-1 overflow-y-auto">
              {shown.map((channel) => (
                <li key={channel.id} className="flex items-center gap-3 px-1 py-1">
                  <Icon name="channel" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-body text-ink">{channel.name}</span>
                    {/* What it is before it is joined: who is in it, and what it is for (D-166). */}
                    <span className="flex min-w-0 items-baseline gap-1 text-caption text-ink-muted">
                      <span className="shrink-0">
                        {t('browse.members', { count: channel.memberCount })}
                      </span>
                      {channel.topic === null || channel.topic.trim() === '' ? null : (
                        <>
                          <span aria-hidden="true" className="shrink-0">
                            ·
                          </span>
                          <span className="truncate">{channel.topic}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <Button
                    busy={joining === channel.id}
                    aria-label={t('browse.joinLabel', { name: channel.name ?? '' })}
                    onClick={() => {
                      void join(channel.id);
                    }}
                  >
                    {t('browse.join')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
};
