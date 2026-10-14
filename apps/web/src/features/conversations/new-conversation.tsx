/**
 * Starting a conversation with a few people (D-127): the workspace's people, narrowed as you type,
 * picked one by one — the picked ones named in "To:" — and Start conversation, which opens the
 * conversation of exactly these people (the same people always open the same one) and goes there.
 * At most `CONVERSATION_PEOPLE_MAX` people with you; past that a channel is the place, and the list
 * says so rather than refusing a click.
 */
import { useState } from 'react';
import { CONVERSATION_PEOPLE_MAX } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { useLocalTime } from '../profile/local-time';
import type { Profile } from '@purlay/types';

/** The people besides the person themselves. */
const OTHERS_MAX = CONVERSATION_PEOPLE_MAX - 1;

/** What somebody does and the time it is where they are, under their name where people are picked (D-131). */
const PersonDetail = ({
  profile,
}: {
  readonly profile: Profile | undefined;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const time = useLocalTime(profile);
  const parts = [
    profile?.title ?? null,
    time === null ? null : t('profile.localTime', { time }),
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return <span className="truncate text-caption text-ink-muted">{parts.join(' · ')}</span>;
};

export const NewConversationDialog = ({
  open,
  onOpenChange,
  startWith = [],
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** People already picked when it opens: a group's, to start a larger conversation from (D-127). */
  readonly startWith?: readonly string[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { openConversation } = useActions();
  const { navigate } = useRoute();
  const members = useMembers(workspace.id);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<readonly string[]>(startWith);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const everybody = (members.data ?? []).map((member) => member.user);
  const profiles = new Map((members.data ?? []).map((member) => [member.user.id, member.profile]));
  const others = everybody.filter((person) => person.id !== user.id);
  const wanted = filter.trim().toLowerCase();
  const shown = others.filter(
    (person) =>
      wanted === '' ||
      person.username.toLowerCase().includes(wanted) ||
      person.displayName.toLowerCase().includes(wanted),
  );
  const full = picked.length >= OTHERS_MAX;
  const names = picked
    .map((id) => everybody.find((person) => person.id === id)?.displayName ?? '')
    .join(', ');

  const toggle = (id: string): void => {
    setFailed(null);
    setPicked((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));
  };

  const close = (next: boolean): void => {
    if (!next) {
      setFilter('');
      setPicked(startWith);
      setFailed(null);
    }
    onOpenChange(next);
  };

  const start = (): void => {
    setStarting(true);
    setFailed(null);
    openConversation(workspace.id, picked).then(
      (channel) => {
        setStarting(false);
        close(false);
        navigate(href('channel', { slug: workspace.slug, channelId: channel.id }));
      },
      (failure: unknown) => {
        setStarting(false);
        setFailed(`${t('conversations.failed')} ${describe(failure)}`);
      },
    );
  };

  const body = ((): React.ReactNode => {
    if (members.isPending) return <p className="text-body text-ink-muted">{t('people.loading')}</p>;
    if (members.isError) {
      return (
        <div role="alert" className="flex items-center gap-2 text-body text-danger-text">
          {`${t('people.failed')} ${describe(members.error)}`}
          <Button
            onClick={() => {
              void members.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    if (others.length === 0) return <p className="text-body text-ink-muted">{t('people.none')}</p>;
    if (shown.length === 0)
      return <p className="text-body text-ink-muted">{t('people.noMatch')}</p>;
    return (
      <ul className="flex max-h-palette-list flex-col gap-1 overflow-y-auto">
        {shown.map((person) => {
          const chosen = picked.includes(person.id);
          return (
            <li key={person.id} className="flex items-center gap-2">
              <Avatar name={person.displayName} username={person.username} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body text-ink">
                  {person.displayName}
                  <span className="text-ink-muted">{` @${person.username}`}</span>
                </span>
                <PersonDetail profile={profiles.get(person.id)} />
              </span>
              <Button
                variant={chosen ? 'primary' : 'secondary'}
                aria-pressed={chosen}
                aria-label={`${chosen ? t('conversations.picked') : t('conversations.pick')} ${person.displayName}`}
                disabled={!chosen && full}
                onClick={() => {
                  toggle(person.id);
                }}
              >
                {chosen ? t('conversations.picked') : t('conversations.pick')}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('conversations.new')}
      description={t('conversations.dialog.description', { max: CONVERSATION_PEOPLE_MAX })}
      closeLabel={t('common.close')}
      footer={
        <Button variant="primary" busy={starting} disabled={picked.length === 0} onClick={start}>
          {t('conversations.start')}
        </Button>
      }
    >
      <p aria-live="polite" className="text-label text-ink">
        {picked.length === 0 ? t('conversations.toNobody') : t('conversations.to', { names })}
      </p>
      <TextField
        label={t('people.filter')}
        value={filter}
        autoComplete="off"
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      {full ? <p className="text-caption text-ink-muted">{t('conversations.full')}</p> : null}
      {body}
      {failed === null ? null : (
        <p role="alert" className="text-caption text-danger-text">
          {failed}
        </p>
      )}
    </Dialog>
  );
};
