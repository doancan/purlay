/**
 * "Skip to the conversation" — the first thing Tab finds.
 *
 * Without it a keyboard user crosses the whole sidebar on every page load before
 * reaching the thing they came for. It is moved out of the viewport rather than
 * hidden (`display: none` would take it out of the tab order too) and slides into
 * view on focus, over everything (`z-toast`), with the same ring as any control.
 */
const skipClasses =
  'absolute left-4 top-2 z-toast -translate-y-full rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-1 text-label text-ink focus:translate-y-0';

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
