/**
 * The two states every view has besides "here it is": nothing yet, and it
 * failed (`UX.md` §8, D-53).
 *
 * **An empty screen is an invitation to act**, not a mood: it says what this
 * place is for and, when there is one, offers the next action. **An error says
 * what happened and what to do and never apologises** — and it keeps the person's
 * work: the error state replaces the content that failed to load, not the
 * composer beside it.
 *
 * Both take their words as props. They are layout and semantics; the sentences
 * belong to the screen that knows what failed, in the language it is in.
 */
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { Button } from './button';

type Heading = 'h1' | 'h2' | 'h3';

interface EmptyStateProps {
  readonly title: string;
  readonly body: string;
  /** The next action, if there is one: a button or a link. */
  readonly action?: React.ReactNode;
  /** The heading level in the page's outline; `h2` under a page's `h1`. */
  readonly as?: Heading;
}

export const EmptyState = ({
  title,
  body,
  action,
  as: Title = 'h2',
}: EmptyStateProps): React.JSX.Element => (
  <section className="flex flex-col items-start gap-2 px-4 py-8">
    <Title className="text-display text-ink">{title}</Title>
    <p className="max-w-feed text-balance text-body text-ink-muted">{body}</p>
    {action}
  </section>
);

/** The tile's tone: an invitation (accent), or all done (success). */
const tileTones = {
  accent: 'bg-accent-subtle text-accent-text',
  success: 'bg-success-subtle text-success-text',
} as const;

interface GlyphEmptyStateProps {
  readonly glyph: GlyphName;
  readonly tone: keyof typeof tileTones;
  readonly title: string;
  /** What this place is for, or how something gets here; a title that says it all needs none. */
  readonly body?: string;
  /** The next action, if there is one: a button or a link. */
  readonly action?: React.ReactNode;
  /** The heading level in the page's outline: `h2` on a screen, `h3` in a panel under its heading. */
  readonly as?: Exclude<Heading, 'h1'>;
  /**
   * Drawn in the list's own card, where the rows would stand, so an empty list keeps the shape of a full one.
   * `false` where it already stands in a card: a card inside a card is a frame too many.
   */
  readonly framed?: boolean;
}

/**
 * Nothing here — a list that is empty because it is done or not started (the inbox, the open questions,
 * saved messages, a side panel, an administration list): one design everywhere, a glyph in a tile, the title
 * and the sentence under it, centred in the card the list's rows would stand in. One component so each has
 * the same room and the same frame: the screens drew their own, and some floated on the page's ground (#625).
 */
export const GlyphEmptyState = ({
  glyph,
  tone,
  title,
  body,
  action,
  as: Title = 'h2',
  framed = true,
}: GlyphEmptyStateProps): React.JSX.Element => (
  <section
    className={cn(
      'flex w-full flex-col items-center gap-3 text-center',
      framed
        ? 'rounded-xl border-hairline border-border-subtle bg-surface-100 px-6 py-12 shadow-card max-narrow:px-4 max-narrow:py-8'
        : 'px-4 py-8',
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-avatar-lg items-center justify-center rounded-lg',
        tileTones[tone],
      )}
    >
      <Icon name={glyph} size="lg" />
    </span>
    <div className="flex max-w-dialog flex-col gap-1">
      <Title className="text-title text-ink">{title}</Title>
      {body !== undefined && <p className="text-balance text-body text-ink-muted">{body}</p>}
    </div>
    {action !== undefined && <div className="mt-1">{action}</div>}
  </section>
);

interface ErrorStateProps {
  readonly title: string;
  readonly body: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  /**
   * Drawn in the list's own card, as `GlyphEmptyState` is, where a list screen's rows would stand: a failure
   * keeps the shape of the list it replaces. Unframed, it starts at the column's edge, as the rows would.
   */
  readonly framed?: boolean;
}

/** `role="alert"`: a failure that replaces content is announced the moment it appears. */
export const ErrorState = ({
  title,
  body,
  retryLabel,
  onRetry,
  framed = false,
}: ErrorStateProps): React.JSX.Element => (
  <section
    role="alert"
    className={cn(
      'flex flex-col items-start gap-3',
      framed
        ? 'w-full rounded-xl border-hairline border-border-subtle bg-surface-100 px-6 py-8 shadow-card max-narrow:px-4'
        : 'py-8',
    )}
  >
    <div className="flex items-center gap-2 text-label text-danger-text">
      <Icon name="failed" />
      <h2 className="text-label">{title}</h2>
    </div>
    <p className="max-w-feed text-balance text-body text-ink-muted">{body}</p>
    <Button onClick={onRetry}>{retryLabel}</Button>
  </section>
);
