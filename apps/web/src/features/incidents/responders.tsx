/**
 * Who is responding to an incident, in its panel (#487, D-137 §3): each with their avatar, first
 * brought in first. A member of the channel says "I'm responding", brings somebody else in it in, and
 * takes anyone off — each painted at once and put back if refused. A visitor reads the list.
 *
 * Somebody who left the channel stays on it: a record of who responded, never a change made silently.
 */
import { nameOf } from '../messages/author';
import type { Incident } from '@purlay/types';
import { useId, useRef } from 'react';
import { useChannelMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Menu, MenuItem } from '../../ui/menu';
import { useSession } from '../session/session';
import type { IncidentActions } from './use-incident';

export const Responders = ({
  channelId,
  incident,
  actions,
  member,
}: {
  readonly channelId: string;
  readonly incident: Incident;
  readonly actions: IncidentActions;
  /** In the channel: offered the changes; a visitor reads. */
  readonly member: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { user: me } = useSession();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  /** Painted at once, the control pressed may be gone: the person's place is the list's heading. */
  const respond = (person: Incident['responders'][number], responding: boolean): void => {
    heading.current?.focus();
    void actions.respond(incident, person, responding);
  };
  // Who could be brought in: read only for somebody who may bring them.
  const members = useChannelMembers(channelId, member);
  const responding = new Set(incident.responders.map((person) => person.id));
  const candidates = (members.data ?? [])
    .map((entry) => entry.user)
    .filter((person) => !responding.has(person.id) && person.id !== me.id);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 px-4 pb-3">
      <h3 ref={heading} id={headingId} tabIndex={-1} className="text-label font-semibold text-ink">
        {t('incident.responders', { count: incident.responders.length })}
      </h3>
      {incident.responders.length === 0 ? (
        <p className="text-label text-ink-muted">{t('incident.nobodyResponding')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {incident.responders.map((person) => (
            <li key={person.id} className="flex min-w-0 items-center gap-2">
              <Avatar
                name={nameOf(person, t('user.erased'))}
                username={person.username}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {person.id === me.id
                  ? t('incident.you', { name: nameOf(person, t('user.erased')) })
                  : nameOf(person, t('user.erased'))}
              </span>
              {member && (
                <Button
                  variant="ghost"
                  aria-label={t('incident.takeOff', { name: nameOf(person, t('user.erased')) })}
                  onClick={() => {
                    respond(person, false);
                  }}
                >
                  {t('incident.takeOffShort')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {member && (
        <div className="flex flex-wrap gap-2">
          {!responding.has(me.id) && (
            <Button
              onClick={() => {
                respond(me, true);
              }}
            >
              {t('incident.imResponding')}
            </Button>
          )}
          {members.isError && members.data === undefined && (
            // Who could be brought in is unknown: said, with Retry — never a menu silently missing.
            <span className="flex items-center gap-2 text-label text-danger-text">
              {t('incident.membersFailed')}
              <Button
                variant="ghost"
                aria-label={t('incident.retryMembers')}
                onClick={() => {
                  void members.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </span>
          )}
          {candidates.length > 0 && (
            <Menu align="start" trigger={<Button variant="ghost">{t('incident.bringIn')}</Button>}>
              {candidates.map((person) => (
                <MenuItem
                  key={person.id}
                  onSelect={() => {
                    respond(person, true);
                  }}
                >
                  {nameOf(person, t('user.erased'))}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      )}
    </section>
  );
};
