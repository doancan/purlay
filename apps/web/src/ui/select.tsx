/**
 * A native select, drawn like the product's other controls: the field's height, edge and type, and a
 * chevron of the icon set instead of each browser's own arrow.
 *
 * Native on purpose: a role, a retention window or a filter is one value from a short list, and the
 * browser's select is accessible, keyboard-complete and right on a phone (a wheel on iOS) without a
 * line of ours. Its label is the caller's — a `<label htmlFor>` beside it or an `aria-label`.
 */
import { Icon } from '../components/icon';
import { cn } from './cn';

export const Select = ({
  className,
  children,
  ...rest
}: React.ComponentPropsWithRef<'select'>): React.JSX.Element => (
  <span className={cn('relative inline-flex', className)}>
    <select
      {...rest}
      className="h-control w-full select-base cursor-pointer rounded-md border-hairline border-border-strong bg-surface-100 pr-8 pl-3 text-label text-ink transition-colors duration-hover ease-standard hover:bg-surface-050 disabled:cursor-not-allowed disabled:text-ink-muted max-narrow:h-touch"
    >
      {children}
    </select>
    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ink-muted">
      <Icon name="collapse" size="sm" />
    </span>
  </span>
);
