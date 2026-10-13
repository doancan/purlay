/**
 * The button — one height, five meanings.
 *
 * A control is `h-control` tall (`UX.md` §1: density), a `radius-md` corner with a
 * hairline edge, and says what it does in the `label` text style. The variant is
 * the *meaning*, not a colour:
 *
 * - `primary` — the one thing the screen is for. Accent is spent here and on
 *   links and the active row, nowhere else, so it still means "this".
 * - `secondary` — the default: an action that is not the point.
 * - `ghost` — in a toolbar or a row, where an edge on every control would be noise.
 * - `danger` — destructive and not undoable, filled so it cannot be mistaken.
 * - `dangerQuiet` — a destructive action *offered*, not yet taken (Leave, Archive): the danger ink
 *   with no fill, so it reads as a warning; the step that takes it asks first and is `danger`.
 *
 * `disabled` looks the same for all five on purpose: the variant says what a
 * control would do, and a control that cannot do it says nothing. The edge stays
 * (`border-border-subtle`), so a disabled control is still a control and still
 * readable (`ink-muted` on `surface-200` is in the contrast table).
 *
 * `busy` is a pending request: it disables the button and says so to assistive
 * technology, and the label does not change — a button that rewrites itself to
 * "Sending…" moves everything beside it.
 */
import { Icon, type GlyphName } from '../components/icon';
import { cn } from './cn';

const baseClasses =
  'inline-flex h-control max-narrow:h-touch shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border-hairline px-3 text-label transition-colors duration-hover ease-standard disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-surface-200 disabled:text-ink-muted';

const variantClasses = {
  primary: 'border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover',
  secondary: 'border-border-subtle bg-surface-100 text-ink shadow-card hover:bg-surface-050',
  ghost: 'border-transparent text-ink-muted hover:bg-surface-200 hover:text-ink',
  danger: 'border-danger bg-danger text-on-status',
  dangerQuiet: 'border-transparent text-danger-text hover:bg-danger-subtle',
} as const;

export type ButtonVariant = keyof typeof variantClasses;

/** The look of a button on something that is not a `<button>` — a link that is the page's next step. */
export const buttonStyle = (variant: ButtonVariant): string =>
  cn(baseClasses, variantClasses[variant]);

export interface ButtonProps extends Omit<React.ComponentPropsWithRef<'button'>, 'children'> {
  readonly variant?: ButtonVariant;
  /** A glyph before the label. Decorative: the label says what the button does. */
  readonly glyph?: GlyphName;
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}

export const Button = ({
  variant = 'secondary',
  glyph,
  busy = false,
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element => (
  <button
    {...rest}
    type={type}
    disabled={disabled === true || busy}
    aria-busy={busy || undefined}
    className={cn(baseClasses, variantClasses[variant], className)}
  >
    {glyph === undefined ? null : <Icon name={glyph} size="sm" />}
    {children}
  </button>
);
