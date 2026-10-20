/**
 * A conversation with one other person, headed by them (#488, D-131): their name, which opens their
 * profile beside the conversation, the time it is where they are, and their status line — so a
 * message is not sent at three in their morning without knowing it.
 */
import { nameOf } from '../messages/author';
import type { User } from '@purlay/types';
import { useId } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useSession } from '../session/session';
import { useSidePanel } from '../channel/side-panel';
import { useLocalTime, useMember } from './local-time';
import { PROFILE_PANEL_ID } from './profile-panel';

export const PeerHeading = ({
  peer,
  title,
}: {
  readonly peer: User;
  readonly title: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const side = useSidePanel();
  const { user } = useSession();
  // Your own time and status, in a note to yourself, would only tell you what you know.
  const self = peer.id === user.id;
  const found = useMember(peer.id).member?.profile;
  const profile = self ? undefined : found;
  const time = useLocalTime(profile);
  const open = side.panel === 'profile';
  const hintId = useId();
  return (
    <>
      <h1 className="min-w-0 truncate text-title text-ink">
        <button
          type="button"
          data-panel-toggle="profile"
          // The visible name stays the button's name, as it is the heading's (WCAG 2.5.3); what it
          // does is said beside it.
          aria-describedby={hintId}
          aria-pressed={open}
          aria-controls={open ? PROFILE_PANEL_ID : undefined}
          className="max-w-full truncate rounded-sm hover:text-accent-text"
          onClick={() => {
            if (open) side.close();
            else side.open('profile');
          }}
        >
          {title}
        </button>
      </h1>
      {/* Beside the heading, not in it: the heading's name is the person's, and only that. */}
      <VisuallyHidden id={hintId}>
        {t('profile.open', { name: nameOf(peer, t('user.erased')) })}
      </VisuallyHidden>
      {time !== null && (
        <span className="shrink-0 font-mono text-caption text-ink-muted max-narrow:hidden">
          {t('profile.localTime', { time })}
        </span>
      )}
      {profile?.status != null && (
        <span className="min-w-0 truncate text-label text-ink-muted max-narrow:hidden">
          {profile.status}
        </span>
      )}
    </>
  );
};
