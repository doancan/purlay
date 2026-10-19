/**
 * One line of the sidebar that goes somewhere: a channel, or a conversation with a person.
 *
 * The treatment is the same for both because the signal is the same (`UX.md` §2): a row
 * with something unread is **bold**, the row you are in is filled with the accent, and a count
 * — the only one in the product — appears only for what *needs you*, a mention or a
 * message in a direct message. Bold is the unread signal, never a dot or a colour, so it
 * survives colour-blindness and a screen reader hears it as the word "unread" before the
 * name rather than as a typographic accident.
 */
import type { Channel, ChannelIncident } from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Badge } from '../../ui/badge';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useDeepWork } from '../shell/deep-work';
import { useRowMenu } from './row-menu';

/** `group`, so what is drawn on the row can follow its hover (a group's faces, D-167). */
const rowClasses =
  'group flex h-row w-full items-center gap-2 rounded-lg px-2 text-body transition-colors duration-hover ease-standard max-narrow:h-touch';

const incidentClasses =
  'inline-flex h-badge shrink-0 items-center rounded-pill bg-danger-subtle px-1 font-mono text-caption font-medium text-danger-text';

const toneClasses = {
  quiet: 'text-nav-ink-muted hover:bg-nav-hover',
  unread: 'text-nav-ink font-semibold hover:bg-nav-hover',
  current: 'bg-accent text-on-accent font-medium',
} as const;

/** What a row looks like, from what is true of it: where you are beats what is unread. */
const rowTone = (current: boolean, unread: boolean): keyof typeof toneClasses =>
  current ? 'current' : unread ? 'unread' : 'quiet';

interface RowContentProps {
  readonly glyph?: GlyphName;
  /** The channel's open incident (D-137 §8): its severity, marked after the name. */
  readonly incident?: ChannelIncident | null;
  /** A person's avatar, in the place a channel has its `#`: a row has one or the other. */
  readonly avatar?: React.ReactNode;
  readonly unread: boolean;
  readonly mentions: number;
  /** Set to tell nothing (D-107): said by a bell struck through after the name, never by hiding. */
  readonly muted?: boolean;
  readonly current: boolean;
  readonly children: React.ReactNode;
}

/** What is inside a row, so a row that is a button and one that is a link look the same. */
const RowContent = ({
  glyph,
  avatar,
  incident = null,
  unread,
  mentions,
  muted = false,
  children,
}: Omit<RowContentProps, 'current'>): React.JSX.Element => {
  const { t } = useI18n();
  const quiet = useDeepWork().until;
  return (
    <>
      {glyph === undefined ? null : <Icon name={glyph} />}
      {avatar}
      <span className="min-w-0 flex-1 truncate">
        {unread ? <VisuallyHidden>{t('sidebar.unread')} </VisuallyHidden> : null}
        {children}
      </span>
      {muted && (
        <span className="shrink-0 text-nav-ink-muted">
          <Icon name="deep-work" size="sm" label={t('sidebar.muted')} />
        </span>
      )}
      {/* A state, not a count: what is on fire here, said in words to a screen reader. */}
      {incident !== null && (
        <span className={incidentClasses}>
          <span aria-hidden="true">{t('incident.sev', { n: incident.severity })}</span>
          <VisuallyHidden>
            {`, ${t('incident.mark', { n: incident.severity, status: t(`incident.${incident.status}`) })}`}
          </VisuallyHidden>
        </span>
      )}
      {/* In Deep Work the count is kept and not drawn: nothing in the sidebar asks for attention. */}
      {mentions > 0 && quiet === null ? (
        <Badge count={mentions} label={t('sidebar.mentions', { count: mentions })} />
      ) : null}
    </>
  );
};

interface ChannelLinkProps extends RowContentProps {
  readonly slug: string;
  /** What it opens, and what its context menu acts on (D-165). */
  readonly channel: Channel;
}

/**
 * A row that opens a conversation the person is already in. A right click, Shift+F10 or a long press
 * opens its context menu (D-165); the menu says it exists only by opening, as a desktop's does.
 */
export const ChannelRow = ({
  slug,
  channel,
  current,
  children,
  ...content
}: ChannelLinkProps): React.JSX.Element => {
  const { handlers, menu } = useRowMenu(channel, current);
  return (
    <>
      <Link
        to="channel"
        params={{ slug, channelId: channel.id }}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        {...handlers}
        className={cn(rowClasses, toneClasses[rowTone(current, content.unread)])}
      >
        <RowContent {...content}>{children}</RowContent>
      </Link>
      {menu}
    </>
  );
};

interface ActionRowProps extends Omit<RowContentProps, 'current'> {
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

/** A row that *does* something — opens a conversation that does not exist yet. */
export const ActionRow = ({
  onClick,
  disabled = false,
  children,
  ...content
}: ActionRowProps): React.JSX.Element => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(rowClasses, toneClasses[rowTone(false, content.unread)], 'text-left')}
  >
    <RowContent {...content}>{children}</RowContent>
  </button>
);
