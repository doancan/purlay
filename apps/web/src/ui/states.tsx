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
    <p className="max-w-feed text-body text-ink-muted">{body}</p>
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
  readonly body: string;
  /** The heading level in the page's outline: `h2` on a screen, `h3` in a panel under its heading. */
  readonly as?: Exclude<Heading, 'h1'>;
}

/**
 * Nothing here, centred under a glyph in a tile — a list that is empty because it is done or not
 * started (the inbox, the open questions, saved messages, a side panel). One component so each has
 * the same room above it: the screens wrote their own copy and drew it against the header (#625).
 */
export const GlyphEmptyState = ({
  glyph,
  tone,
  title,
  body,
  as: Title = 'h2',
}: GlyphEmptyStateProps): React.JSX.Element => (
  <section className="flex max-w-feed flex-col items-center gap-3 px-4 py-8 text-center">
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-avatar-lg items-center justify-center rounded-lg',
        tileTones[tone],
      )}
    >
      <Icon name={glyph} size="lg" />
    </span>
    <Title className="text-title text-ink">{title}</Title>
    <p className="text-body text-ink-muted">{body}</p>
  </section>
);

interface ErrorStateProps {
  readonly title: string;
  readonly body: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}

/** `role="alert"`: a failure that replaces content is announced the moment it appears. */
export const ErrorState = ({
  title,
  body,
  retryLabel,
  onRetry,
}: ErrorStateProps): React.JSX.Element => (
  <section role="alert" className="flex flex-col items-start gap-3 px-4 py-8">
    <div className="flex items-center gap-2 text-label text-danger-text">
      <Icon name="failed" />
      <h2 className="text-label">{title}</h2>
    </div>
    <p className="max-w-feed text-body text-ink-muted">{body}</p>
    <Button onClick={onRetry}>{retryLabel}</Button>
  </section>
);
