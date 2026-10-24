/**
 * "Skip to the conversation" — the first thing Tab finds.
 *
 * Without it a keyboard user crosses the whole sidebar on every page load before
 * reaching the thing they came for. It is moved wholly out of the viewport (stopped at the edge, its
 * bottom border showed over a dialog's scrim) rather than
 * hidden (`display: none` would take it out of the tab order too) and slides into
 * view on focus, over everything (`z-toast`), with the same ring as any control.
 */
const skipClasses =
  'absolute -top-full left-4 z-toast focus:top-2 rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-1 text-label text-ink';

interface SkipLinkProps {
  /** The `id` of the element that holds the page's main content. */
  readonly target: string;
  readonly children: React.ReactNode;
}

export const SkipLink = ({ target, children }: SkipLinkProps): React.JSX.Element => (
  <a href={`#${target}`} className={skipClasses}>
    {children}
  </a>
);
