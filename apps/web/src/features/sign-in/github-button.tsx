/**
 * "Continue with GitHub": a link to `/auth/github`, which the browser follows by itself — unless the page
 * has something to do first (`before`), as the invitation page does: it asks for its passport, and only
 * once the server has given it (the cookie is set by that answer) does the page leave for GitHub. A
 * `before` that fails keeps the person here and says why; nothing else happens.
 */
import { useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { buttonStyle } from '../../ui/button';
import { cn } from '../../ui/cn';
import { leave } from './leave';

const GITHUB_PATH = '/auth/github';

interface GitHubButtonProps {
  readonly variant?: 'primary' | 'secondary';
  /** What must be done before leaving; it handles its own failure and says whether to go on. */
  readonly before?: () => Promise<boolean>;
}

export const GitHubButton = ({
  variant = 'primary',
  before,
}: GitHubButtonProps): React.JSX.Element => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    // A plain anchor on purpose: the browser must leave this page.
    <a
      href={GITHUB_PATH}
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
                if (goOn) leave.to(GITHUB_PATH);
                else setBusy(false);
              });
            }
      }
    >
      <Icon name="github" />
      {t('signIn.github')}
    </a>
  );
};
