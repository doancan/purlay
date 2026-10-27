/**
 * The heading of a sidebar section (D-195): its name, which folds it, and the actions that belong to it.
 *
 * The name is a button — its name stays the section's, its state is `aria-expanded` (the disclosure
 * pattern), and a chevron after the name says which way it will go — because folding is
 * the person's, and a heading that only looked like a label would hide the one control that tidies the
 * column. The chevron is after the name, so the name lines up with the rows' glyphs beneath it; it is quiet until the pointer or the keyboard is on the heading, and always drawn
 * once the section is folded, so a folded section says so without a hover (and on a touch screen,
 * which has none, it is always drawn). The actions sit at the other end, always shown (D-110): a way in
 * that appears only under a pointer is one a newcomer never finds.
 *
 * A folded section is not an empty one: what is unread, what mentions the person and the open row stay
 * listed beneath it (`shownRows`), so folding never hides what is waiting.
 */
import { Icon } from '../../components/icon';
import { cn } from '../../ui/cn';

interface SectionHeadingProps {
  /** Names the list this heading folds, for `aria-controls`. */
  readonly controls: string;
  readonly id?: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
}

export const SectionHeading = ({
  controls,
  id,
  collapsed,
  onToggle,
  children,
  actions,
}: SectionHeadingProps): React.JSX.Element => (
  <div className="flex items-center justify-between">
    <h2 {...(id === undefined ? {} : { id })} className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={controls}
        onClick={onToggle}
        className="group flex h-control max-narrow:h-touch w-full items-center gap-1 rounded-md px-2 text-left text-label text-nav-ink-muted transition-colors duration-hover ease-standard hover:text-nav-ink"
      >
        <span className="min-w-0 truncate">{children}</span>
        <span
          className={cn(
            'transition-opacity duration-hover ease-standard group-hover:opacity-100 group-focus-visible:opacity-100 max-narrow:opacity-100',
            collapsed ? 'opacity-100' : 'opacity-0',
          )}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} size="sm" />
        </span>
      </button>
    </h2>
    {actions === undefined ? null : <div className="flex shrink-0">{actions}</div>}
  </div>
);
