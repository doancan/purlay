/**
 * A button that is only an icon — which must therefore say what it is.
 *
 * `label` is required by the type, not by a lint rule or a review comment: an
 * icon-only control with no name is unusable with a screen reader, and the
 * cheapest place to make that impossible is the signature. The label is both the
 * accessible name and the tooltip, so a sighted person who does not know the
 * glyph is one hover from learning it.
 *
 * Square by `aspect-square` on the control height, so the target is as tall as
 * every other control in a row and as wide as it is tall.
 */
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';
import { Tooltip } from './tooltip';

const iconButtonClasses =
  'inline-flex shrink-0 items-center justify-center transition-colors duration-hover ease-standard disabled:cursor-not-allowed disabled:text-ink-muted';

/**
 * Two sizes. A control sits in a row with other controls and is as tall as they are; a rail
 * button is a larger square on the window's edge, with a larger glyph and its tip opening
 * inward (D-110).
 */
const sizeClasses = {
  control:
    'h-control max-narrow:h-touch aspect-square rounded-md text-ink-muted hover:bg-surface-200 hover:text-ink',
  rail: 'size-rail-item rounded-lg text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink max-narrow:h-touch max-narrow:w-touch',
  /** A control in the sidebar, on the navigation's tone (D-118). */
  nav: 'h-control max-narrow:h-touch aspect-square rounded-md text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
} as const;

export interface IconButtonProps extends Omit<
  React.ComponentPropsWithRef<'button'>,
  'children' | 'aria-label'
> {
  /** What the button does: its accessible name and its tooltip. */
  readonly label: string;
  readonly glyph: GlyphName;
  /** The key that does the same thing, shown in the tooltip. */
  readonly shortcut?: string;
  readonly size?: keyof typeof sizeClasses;
}

export const IconButton = ({
  label,
  glyph,
  shortcut,
  size = 'control',
  type = 'button',
  className,
  ...rest
}: IconButtonProps): React.JSX.Element => (
  <Tooltip
    content={label}
    side={size === 'rail' ? 'right' : 'top'}
    {...(shortcut === undefined ? {} : { shortcut })}
  >
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cn(iconButtonClasses, sizeClasses[size], className)}
    >
      <Icon name={glyph} size={size === 'rail' ? 'lg' : 'md'} />
    </button>
  </Tooltip>
);
