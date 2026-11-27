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
import { navMarkerShapeClasses } from '../../ui/nav-row';
import { VisuallyHidden } from '../../ui/visually-hidden';

/** The classes of a rail place, at rest or as the current page. */
export const railItemClasses = (current: boolean): string =>
  cn(
    'relative inline-flex size-rail-item shrink-0 items-center justify-center rounded-lg transition-colors duration-hover ease-standard max-narrow:h-touch max-narrow:w-touch',
    // The glyph is drawn in the full navigation ink at rest, as a rail is a row of marks with no words beside them:
    // the muted ink read as faint at 20px. The current place takes the accent, the selected fill and the bar, which
    // sits on the rail's own edge, a step outside the square, as the rail's inset is two steps.
    current ? 'bg-nav-selected text-accent-text before:-left-2' : 'text-nav-ink hover:bg-nav-hover',
    current && navMarkerShapeClasses,
  );

interface RailItemContentProps {
  readonly glyph: GlyphName;
  readonly label: string;
  /**
   * A count at the corner, or a dot that says it in words; never both. The dot is red, what needs you; the count is the
   * accent blue, the number of what is open.
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
      <span className="absolute top-0 right-0 inline-flex h-badge min-w-badge items-center justify-center rounded-pill border-marker border-nav-rail bg-accent px-1 font-mono text-caption text-on-accent">
        {signal.text}
      </span>
    ) : null}
    {signal?.kind === 'dot' ? (
      <>
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 size-dot rounded-pill border-hairline border-nav-rail bg-danger"
        />
        <VisuallyHidden> {signal.words}</VisuallyHidden>
      </>
    ) : null}
  </>
);
