/**
 * The ground every screen without the shell stands on — signing in, an invitation, the setup, a letter's stop link,
 * a refusal: the page's canvas, one centred column, the one `main` landmark. Each screen draws its own card on it;
 * what the cards share (the canvas, the centring, the gutter) is said once, here, so none of them is a
 * different shade of the same page.
 */
import { cn } from '../../ui/cn';
import { Main } from '../../ui/main';

export const StandaloneScreen = ({
  children,
  placement = 'centre',
}: {
  readonly children: React.ReactNode;
  /**
   * Where the card stands. `centre` is for a card whose height is settled when it is drawn. `top` is for one that grows
   * once something loads (the front door's creation form): a centred card is centred again as it grows, and everything
   * in it moves under a pointer that is on its way to it (#1475).
   */
  readonly placement?: 'centre' | 'top';
}): React.JSX.Element => (
  <Main
    className={cn(
      'flex min-h-screen justify-center bg-surface-000 p-4 text-ink',
      placement === 'top' ? 'items-start pt-16' : 'items-center',
    )}
  >
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
