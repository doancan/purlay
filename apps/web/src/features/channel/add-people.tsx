/**
 * Bringing people from the workspace into a channel (D-104): any member may. A list of the
 * workspace's people, narrowed as you type, each with Add. The person added is told by the server
 * (`CHANNEL_ADDED`) and sees the channel at once.
 *
 * Somebody already in the channel says **Member** instead, quietly, after the people who can be
 * added: an Add that does nothing is a control that lies. The channel's members are read for that
 * alone; until they arrive, or if they cannot be read, everybody is offered Add — the server answers
 * an add of a member as it answers any other, so the list is never wrong, only less helpful.
 */
import { useState } from 'react';
import type { Channel } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { useChannelMembers, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';

type Asked = 'adding' | 'added' | { readonly failed: string };

export const AddPeopleDialog = ({
  channel,
  open,
  onOpenChange,
}: {
  readonly channel: Channel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { user } = useSession();
  const members = useMembers(channel.workspaceId);
  const inChannel = useChannelMembers(channel.id);
  const already = new Set((inChannel.data ?? []).map((member) => member.user.id));
  const [filter, setFilter] = useState('');
  const [asked, setAsked] = useState<ReadonlyMap<string, Asked>>(new Map());

  const add = (userId: string): void => {
    setAsked((now) => new Map(now).set(userId, 'adding'));
    api.addChannelMember(channel.id, userId).then(
      () => {
        setAsked((now) => new Map(now).set(userId, 'added'));
      },
      (failure: unknown) => {
        setAsked((now) => new Map(now).set(userId, { failed: describe(failure) }));
      },
    );
  };

  const wanted = filter.trim().toLowerCase();
  const people = (members.data ?? [])
    .map((member) => member.user)
    .filter((person) => person.id !== user.id)
    .filter(
      (person) =>
        wanted === '' ||
        person.username.toLowerCase().includes(wanted) ||
        person.displayName.toLowerCase().includes(wanted),
    )
    // Who can be added first; the channel's members after, as they cannot be.
    .sort((a, b) => Number(already.has(a.id)) - Number(already.has(b.id)));

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
    if (members.data.every((member) => member.user.id === user.id)) {
      return <p className="text-body text-ink-muted">{t('people.none')}</p>;
    }
    if (people.length === 0)
      return <p className="text-body text-ink-muted">{t('people.noMatch')}</p>;
    // Nobody left to bring in: said, rather than left for the person to find by reading every row.
    const allIn =
      wanted === '' && people.every((person) => already.has(person.id) && !asked.has(person.id));
    return (
      <>
        {allIn && <p className="text-body text-ink-muted">{t('people.allIn')}</p>}
        <ul className="flex max-h-palette-list flex-col gap-1 overflow-y-auto">
          {people.map((person) => {
            const state = asked.get(person.id);
            const failed = typeof state === 'object' ? state.failed : null;
            return (
              <li key={person.id} className="flex items-center gap-2">
                <Avatar name={person.displayName} username={person.username} size="sm" />
                <span className="min-w-0 flex-1 truncate text-body text-ink">
                  {person.displayName}
                  <span className="text-ink-muted">{` @${person.username}`}</span>
                </span>
                {failed !== null && (
                  <span role="alert" className="text-caption text-danger-text">
                    {`${t('people.addFailed', { name: person.displayName })} ${failed}`}
                  </span>
                )}
                {state === undefined && already.has(person.id) ? (
                  <span className="inline-flex h-control items-center px-3 text-label text-ink-muted max-narrow:h-touch">
                    {t('people.member')}
                  </span>
                ) : (
                  <Button
                    variant={state === 'added' ? 'ghost' : 'secondary'}
                    busy={state === 'adding'}
                    disabled={state === 'added'}
                    onClick={() => {
                      add(person.id);
                    }}
                  >
                    {state === 'added' ? t('people.added') : t('people.addOne')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFilter('');
          setAsked(new Map());
        }
        onOpenChange(next);
      }}
      title={t('people.title', { name: channel.name ?? '' })}
      description={t('people.description')}
      closeLabel={t('common.close')}
    >
      <TextField
        label={t('people.filter')}
        value={filter}
        autoComplete="off"
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      {body}
    </Dialog>
  );
};
