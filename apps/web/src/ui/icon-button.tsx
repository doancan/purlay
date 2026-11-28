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

// A disabled one does not answer the pointer: no tint under it, whatever its size's hover is.
const iconButtonClasses =
  'inline-flex shrink-0 items-center justify-center transition-colors duration-hover ease-standard disabled:cursor-not-allowed disabled:bg-transparent disabled:text-ink-muted';

/**
 * Sizes. A control sits in a row with other controls and is as tall as they are; a rail
 * button is a larger square on the window's edge, with a larger glyph and its tip opening
 * inward (D-110). Pressed (`active:`) is one step firmer than hover, as a button's is: `border-subtle`
 * is a step past `surface-200` and `nav-hover` in every theme.
 */
const sizeClasses = {
  /** A toggle in a toolbar that is on (`aria-pressed`) keeps the hover's fill, so it reads as on at rest. */
  control:
    'h-control max-narrow:h-touch aspect-square rounded-md text-ink-muted hover:bg-surface-200 hover:text-ink active:bg-border-subtle active:text-ink aria-pressed:bg-surface-200 aria-pressed:text-ink',
  /**
   * A tool in the composer's formatting row (D-361): the control's square and glyph, in the full ink, so a row of
   * twelve reads at a glance instead of as a faint line of marks.
   */
  tool: 'h-control max-narrow:h-touch aspect-square rounded-md text-ink hover:bg-surface-200 active:bg-border-subtle aria-pressed:bg-surface-200 disabled:text-ink-muted',
  /**
   * A control on a message's bar (D-150): the control's size on every window. A finger-tall bar
   * is taller than the band above a bubble and covered the author's name on a phone; at this size
   * it fits the band, and every target on the bar is the same (above the 24px WCAG minimum).
   */
  bar: 'h-control aspect-square rounded-md text-ink-muted hover:bg-surface-200 hover:text-ink active:bg-border-subtle active:text-ink aria-pressed:text-ink',
  rail: 'size-rail-item rounded-lg text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink active:bg-border-subtle active:text-nav-ink max-narrow:h-touch max-narrow:w-touch',
  /** A control in the sidebar, on the navigation's tone (D-118). */
  nav: 'h-control max-narrow:h-touch aspect-square rounded-md text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink active:bg-border-subtle active:text-nav-ink',
  /**
   * The sidebar's top band: a row's height and corner, as the workspace's door beside it is, so the two are
   * one row of buttons; open, it is selected as the door is.
   */
  head: 'h-control max-narrow:h-touch aspect-square rounded-lg text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink active:bg-border-subtle active:text-nav-ink data-[state=open]:bg-nav-selected data-[state=open]:text-nav-ink',
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
  /**
   * What the tooltip says, when it is not the name: a toggle keeps one name and says its state in
   * `aria-pressed`, while its tooltip says what pressing it now would do ("Unpin").
   */
  readonly tooltip?: string;
}

export const IconButton = ({
  label,
  glyph,
  shortcut,
  size = 'control',
  tooltip = label,
  type = 'button',
  className,
  ...rest
}: IconButtonProps): React.JSX.Element => (
  <Tooltip
    content={tooltip}
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
