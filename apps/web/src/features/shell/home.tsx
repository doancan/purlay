/**
 * `/` — somewhere to go, or somewhere to start.
 *
 * A person with a workspace is sent to the first one (`replace`, so Back does not
 * land on a page that only redirects). A person with none sees why, on a card with the product's
 * mark like the sign-in screen it follows (D-100): with a form to make the first where this server
 * would let them, and otherwise told to ask for an invitation — never a form that would be refused
 * (D-155). The same form is the workspace menu's **Create workspace…**, for a person who has one
 * already and may make another (D-124).
 */
import { useEffect, useState } from 'react';
import { LazyCreateWorkspace } from './create-workspace-load';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { LogoMark } from './notice';
import { ScheduledDeletions } from './scheduled-deletions';
import { useSession } from '../session/session';
import { browserInvitationPorts, pendingInvitation } from '../invitations/pending';
import { browserNativePorts, pendingNativeHandoff } from '../native/pending';

export { SLUG, slugOf } from './workspace-slug';

export const Home = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { memberships, mayCreateWorkspace, isServerAdmin } = useSession();
  const { navigate } = useRoute();
  const first = memberships[0]?.workspace.slug;
  // Back from signing in with an invitation in hand: that is where the person was going (D-115).
  const [invited] = useState(
    () => pendingInvitation(browserInvitationPorts(), window.location) !== null,
  );

  // Or from signing in for the native application, which sent the person here and is still waiting for
  // an answer (D-191). An invitation in hand comes first: it is a join the person started themselves.
  const [asked] = useState(
    () => pendingNativeHandoff(browserNativePorts(), window.location) !== null,
  );

  useEffect(() => {
    if (invited) navigate(href('invite'), { replace: true });
    else if (asked) navigate(href('signInNative'), { replace: true });
    else if (first !== undefined) navigate(href('workspace', { slug: first }), { replace: true });
  }, [invited, asked, first, navigate]);

  if (invited || asked || first !== undefined) return null;
  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <div className="flex w-full max-w-dialog flex-col gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 shadow-card">
        <LogoMark />
        {/* An owner whose last workspace is being deleted can still keep it from here (D-242). */}
        {isServerAdmin && (
          <Button
            onClick={() => {
              navigate(href('serverHome'));
            }}
          >
            {t('admin.title')}
          </Button>
        )}
        <ScheduledDeletions />
        {mayCreateWorkspace ? (
          <>
            <section className="flex flex-col gap-2">
              <h1 className="text-display">{t('workspace.none.title')}</h1>
              <p className="text-body text-ink-muted">{t('workspace.none.body')}</p>
            </section>
            <LazyCreateWorkspace />
          </>
        ) : (
          <section className="flex flex-col gap-2">
            <h1 className="text-display">{t('workspace.closed.title')}</h1>
            <p className="text-body text-ink-muted">{t('workspace.closed.body')}</p>
          </section>
        )}
      </div>
    </Main>
  );
};
