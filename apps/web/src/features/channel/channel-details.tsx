/**
 * A channel's details (D-123), opened from its name in the header: the Details panel of the
 * Superdesign screens, drawn as the product's dialog — its name and topic, who is in it with Add
 * people, what the person is told about, and at the bottom, in the danger tone, Leave and (for an
 * owner or an admin) Archive. Files and pins are not here (#485).
 *
 * What is offered is what the server would allow: only a member edits the name and topic, only a
 * member leaves, only an owner or an admin archives. The server stays the authority, and what it
 * refuses is said in words — a taken name under the name field, the last member of a private channel
 * in a sentence that says what to do instead. Leaving and archiving cost something, so each asks
 * first, in place, as removing a member does.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, UpdateChannelRequest } from '@purlay/types';
import { useId, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannelMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { AddPeopleDialog } from './add-people';
import { CHANNEL_NAME, CHANNEL_NAME_MAX, finishedChannelName } from './channel-name';
import { typeChannelName } from './name-field';
import { NotificationLevelMenu } from './notification-level-menu';

const sectionTitle = 'text-label text-ink-muted';

/** The name and the topic: a form for a member, two lines for anybody else. */
const About = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { updateChannel } = useActions();
  const formId = useId();
  // Only what the person edits is theirs; a field they have not touched shows the channel as it is
  // now, so a rename by somebody else appears here and is never sent back over it (D-123 §6).
  const [editedName, setName] = useState<string | null>(null);
  const [editedTopic, setTopic] = useState<string | null>(null);
  const [problem, setProblem] = useState<{
    field: 'name' | 'topic' | 'form';
    message: string;
  } | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  const name = editedName ?? channel.name ?? '';
  const topic = editedTopic ?? channel.topic ?? '';
  const wanted: UpdateChannelRequest = {
    ...(editedName === null ? {} : { name: finishedChannelName(editedName) }),
    ...(editedTopic === null
      ? {}
      : { topic: editedTopic.trim() === '' ? null : editedTopic.trim() }),
  };
  const changed =
    (wanted.name !== undefined && wanted.name !== channel.name) ||
    (wanted.topic !== undefined && wanted.topic !== channel.topic);

  if (channel.state === null) {
    return (
      <p className="text-body text-ink-muted">
        {channel.topic ?? t('header.noTopic')} · {t('details.onlyMembers')}
      </p>
    );
  }

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (wanted.name !== undefined && !CHANNEL_NAME.test(wanted.name)) {
      setProblem({ field: 'name', message: t('newChannel.invalid') });
      return;
    }
    setState('busy');
    setProblem(null);
    try {
      await updateChannel(channel.id, wanted);
      setName(null);
      setTopic(null);
      setState('saved');
    } catch (failure) {
      setState('idle');
      if (isApiError(failure) && failure.code === 'CHANNEL_NAME_TAKEN') {
        setProblem({ field: 'name', message: t('newChannel.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem(
          'topic' in failure.fields
            ? { field: 'topic', message: t('details.topicInvalid') }
            : { field: 'name', message: t('newChannel.invalid') },
        );
      } else {
        setProblem({ field: 'form', message: `${t('details.saveFailed')} ${describe(failure)}` });
      }
    }
  };

  return (
    <form
      id={formId}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-3"
    >
      <TextField
        label={t('details.name')}
        hint={t('newChannel.nameHint')}
        value={name}
        maxLength={CHANNEL_NAME_MAX}
        autoComplete="off"
        spellCheck={false}
        {...(problem?.field === 'name' ? { error: problem.message } : {})}
        onChange={(event) => {
          typeChannelName(event.target, setName);
          setState('idle');
        }}
      />
      <TextField
        label={t('details.topic')}
        hint={t('newChannel.topicHint')}
        value={topic}
        autoComplete="off"
        {...(problem?.field === 'topic' ? { error: problem.message } : {})}
        onChange={(event) => {
          setTopic(event.target.value);
          setState('idle');
        }}
      />
      <div className="flex items-center justify-end gap-3">
        <p role="status" className="text-label text-ink-muted">
          {state === 'saved' ? t('details.saved') : ''}
        </p>
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
        <Button type="submit" variant="primary" busy={state === 'busy'} disabled={!changed}>
          {t('details.save')}
        </Button>
      </div>
    </form>
  );
};

/** Who is in it, and the way to bring somebody else in. */
const Members = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const client = useQueryClient();
  const { user } = useSession();
  const members = useChannelMembers(channel.id);
  const [adding, setAdding] = useState(false);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className={sectionTitle}>
        {t('details.members', { number: format.number(members.data?.length ?? 0) })}
      </h3>
      {members.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">
            {`${t('details.membersFailed')} ${describe(members.error)}`}
          </p>
          <Button
            onClick={() => {
              void members.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : members.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : members.data.length === 0 ? (
        <p className="text-body text-ink-muted">{t('details.nobody')}</p>
      ) : (
        <ul className="flex max-h-palette-list flex-col gap-2 overflow-y-auto">
          {members.data.map(({ user: person }) => (
            <li key={person.id} className="flex items-center gap-3">
              <Avatar name={person.displayName} username={person.username} size="sm" />
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {person.displayName}{' '}
                <span className="text-caption text-ink-muted">
                  @{person.username}
                  {person.id === user.id && ` · ${t('details.you')}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {channel.state !== null && (
        <>
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('people.add')}
          </Button>
          <AddPeopleDialog
            channel={channel}
            open={adding}
            onOpenChange={(next) => {
              setAdding(next);
              // Whoever was brought in is in the list when it is shown again.
              if (!next)
                void client.invalidateQueries({ queryKey: keys.channelMembers(channel.id) });
            }}
          />
        </>
      )}
    </section>
  );
};

/**
 * Leave, for a member, and Archive, for an owner or an admin: each asks in place first, says what it
 * costs, and when done takes the person to the workspace and says so in a toast.
 */
const Farewell = ({ channel }: { readonly channel: Channel }): React.JSX.Element | null => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { leaveChannel, archiveChannel } = useActions();
  const { workspace } = useWorkspace();
  const { memberships } = useSession();
  const { navigate } = useRoute();
  const { show } = useToast();
  const [asking, setAsking] = useState<'leave' | 'archive' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const role = memberships.find((m) => m.workspace.id === workspace.id)?.role;
  const member = channel.state !== null;
  const archiver = role === 'owner' || role === 'admin';
  const name = channel.name ?? '';
  if (!member && !archiver) return null;

  const act = async (what: 'leave' | 'archive'): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      if (what === 'leave') await leaveChannel(channel);
      else await archiveChannel(channel.id);
      show({ message: t(what === 'leave' ? 'details.left' : 'details.archived', { name }) });
      navigate(href('workspace', { slug: workspace.slug }));
    } catch (failure) {
      setBusy(false);
      setProblem(
        isApiError(failure) && failure.code === 'LAST_CHANNEL_MEMBER'
          ? t('details.lastMember')
          : `${t(what === 'leave' ? 'details.leaveFailed' : 'details.archiveFailed')} ${describe(failure)}`,
      );
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t-hairline border-border-subtle pt-4">
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      {asking === null ? (
        <div className="flex flex-wrap gap-2">
          {member && (
            <Button
              variant="dangerQuiet"
              onClick={() => {
                setAsking('leave');
              }}
            >
              {t('details.leave')}
            </Button>
          )}
          {archiver && (
            <Button
              variant="dangerQuiet"
              onClick={() => {
                setAsking('archive');
              }}
            >
              {t('details.archive')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-label text-ink">
            {t(asking === 'leave' ? 'details.leaveAsk' : 'details.archiveAsk', { name })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setAsking(null);
                setProblem(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                void act(asking);
              }}
            >
              {t(asking === 'leave' ? 'details.leave' : 'details.archive')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export const ChannelDetailsDialog = ({
  channel,
  open,
  onOpenChange,
}: {
  readonly channel: Channel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('details.title', { name: channel.name ?? '' })}
      description={t('details.description')}
      closeLabel={t('common.close')}
    >
      <About channel={channel} />
      <Members channel={channel} />
      {channel.state !== null && (
        <div className="flex items-center justify-between gap-3">
          <span className={sectionTitle}>{t('details.notifications')}</span>
          <NotificationLevelMenu channel={channel} />
        </div>
      )}
      <Farewell channel={channel} />
    </Dialog>
  );
};
