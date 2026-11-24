/**
 * The ground every screen without the shell stands on — signing in, an invitation, the setup, a letter's stop link,
 * a refusal: the page's canvas, one centred column, the one `main` landmark. Each screen draws its own card on it;
 * what the cards share (the canvas, the centring, the gutter) is said once, here, so none of them is a
 * different shade of the same page.
 */
import { Main } from '../../ui/main';

export const StandaloneScreen = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
    {children}
  </Main>
);

/** The card of a screen that only says something — a refusal, a missing page, a failure: the notice, framed. */
export const StandaloneCard = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <div className="flex w-full max-w-dialog flex-col rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-card">
    {children}
  </div>
);
