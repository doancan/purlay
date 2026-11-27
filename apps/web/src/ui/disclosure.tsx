/**
 * A part of a screen closed until asked for: a native `<details>`, so the keyboard and a screen reader open it
 * as they open any other, with one chevron that says which way it goes. The screens drew it three ways (the
 * browser's own triangle in some, a chevron in others), so the same control looked different from one card to
 * the next.
 *
 * The group is named: a disclosure can sit inside another `group`, and an unnamed `group-open` would follow
 * whichever `<details>` is nearest.
 */
import { Icon } from '../components/icon';
import { cn } from './cn';

interface DisclosureProps {
  /** What the closed control says. */
  readonly summary: React.ReactNode;
  /** Open on first draw, as when a filter in it is already set. */
  readonly open?: boolean;
  /** The text style of the whole, summary and content: a disclosure in a caption is a caption. */
  readonly className?: string;
  readonly children: React.ReactNode;
}

export const Disclosure = ({
  summary,
  open = false,
  className,
  children,
}: DisclosureProps): React.JSX.Element => (
  <details open={open || undefined} className={cn('group/disclosure', className)}>
    <summary className="flex w-fit cursor-pointer disclosure-summary items-center gap-1 rounded-sm py-1 text-ink-muted transition-colors duration-hover ease-standard hover:text-ink">
      <span aria-hidden="true" className="inline-flex group-open/disclosure:hidden">
        <Icon name="expand" size="sm" />
      </span>
      <span aria-hidden="true" className="hidden group-open/disclosure:inline-flex">
        <Icon name="collapse" size="sm" />
      </span>
      {summary}
    </summary>
    {children}
  </details>
);
