/**
 * How a place on the rail looks: a square, its glyph, its name for a screen reader and in a tip
 * that opens inward, and the one signal it is owed (D-110).
 *
 * The places themselves are links that already existed — the inbox, the open questions, search —
 * so they keep their own files and their own data, and take their shape from here. That keeps
 * one rail without the rail knowing what an inbox counts.
 */
import { Icon, type GlyphName } from '../../components/icon';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';

/** The classes of a rail place, at rest or as the current page. */
export const railItemClasses = (current: boolean): string =>
  cn(
    'relative inline-flex size-rail-item shrink-0 items-center justify-center rounded-lg transition-colors duration-hover ease-standard max-narrow:h-touch max-narrow:w-touch',
    current
      ? 'bg-accent-subtle text-accent-text'
      : 'text-ink-subtle hover:bg-surface-200 hover:text-ink',
  );

interface RailItemContentProps {
  readonly glyph: GlyphName;
  readonly label: string;
  /**
   * A count at the corner, or a dot that says it in words; never both. The count is neutral: the
   * accent badge is for what needs *you* (`UX.md` §2), and a count of the team's open questions is
   * information, not a summons. The dot is the inbox's — something there does need you.
   */
  readonly signal?:
    | { readonly kind: 'count'; readonly text: string }
    | { readonly kind: 'dot'; readonly words: string };
}

export const RailItemContent = ({
  glyph,
  label,
  signal,
}: RailItemContentProps): React.JSX.Element => (
  <>
    <Icon name={glyph} size="lg" />
    <VisuallyHidden>{label}</VisuallyHidden>
    {signal?.kind === 'count' ? (
      <span className="absolute top-0 right-0 inline-flex h-badge min-w-badge items-center justify-center rounded-pill border-marker border-surface-000 bg-surface-200 px-1 font-mono text-caption text-ink-muted">
        {signal.text}
      </span>
    ) : null}
    {signal?.kind === 'dot' ? (
      <>
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 size-dot rounded-pill border-marker border-surface-000 bg-accent-text"
        />
        <VisuallyHidden> {signal.words}</VisuallyHidden>
      </>
    ) : null}
  </>
);
