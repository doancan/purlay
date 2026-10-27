/**
 * A way of signing in that is a page of somebody else's: a link to one of this server's own addresses
 * (`/auth/github`, `/auth/oidc`), which the browser follows by itself — unless the page has something to do
 * first (`before`), as the invitation page does: it asks for its passport, and only once the server has given
 * it (the cookie is set by that answer) does the page leave. A `before` that fails keeps the person here and
 * says why; nothing else happens. The two buttons are this and a mark, so what a click does is one thing.
 */
import { useState } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { buttonStyle } from '../../ui/button';
import { cn } from '../../ui/cn';
import { leave } from './leave';

export interface ProviderButtonProps {
  readonly variant?: 'primary' | 'secondary';
  /** What must be done before leaving; it handles its own failure and says whether to go on. */
  readonly before?: () => Promise<boolean>;
}

export const ProviderButton = ({
  href,
  icon,
  label,
  variant = 'primary',
  before,
}: ProviderButtonProps & {
  /** One of this server's own paths: the page leaves for it. */
  readonly href: string;
  readonly icon: GlyphName;
  readonly label: string;
}): React.JSX.Element => {
  const [busy, setBusy] = useState(false);
  return (
    // A plain anchor on purpose: the browser must leave this page.
    <a
      href={href}
      aria-busy={busy || undefined}
      className={cn(buttonStyle(variant, 'lg'), 'w-full', busy && 'pointer-events-none')}
      onClick={
        before === undefined
          ? undefined
          : (event): void => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              void before().then((goOn) => {
                // Going: stay busy until the page is gone, so it cannot be pressed twice on the way.
                if (goOn) leave.to(href);
                else setBusy(false);
              });
            }
      }
    >
      <Icon name={icon} />
      {label}
    </a>
  );
};
