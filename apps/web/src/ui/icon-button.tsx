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
  'inline-flex h-control max-narrow:h-touch aspect-square shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-200 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-muted';

export interface IconButtonProps extends Omit<
  React.ComponentPropsWithRef<'button'>,
  'children' | 'aria-label'
> {
  /** What the button does: its accessible name and its tooltip. */
  readonly label: string;
  readonly glyph: GlyphName;
  /** The key that does the same thing, shown in the tooltip. */
  readonly shortcut?: string;
}

export const IconButton = ({
  label,
  glyph,
  shortcut,
  type = 'button',
  className,
  ...rest
}: IconButtonProps): React.JSX.Element => (
  <Tooltip content={label} {...(shortcut === undefined ? {} : { shortcut })}>
    <button {...rest} type={type} aria-label={label} className={cn(iconButtonClasses, className)}>
      <Icon name={glyph} />
    </button>
  </Tooltip>
);
