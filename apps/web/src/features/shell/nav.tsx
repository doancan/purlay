/**
 * The navigation as a thing that can be open or closed — which only matters on a narrow
 * window, where the sidebar is an overlay (`UX.md` §2, D-98).
 *
 * Above the breakpoint the sidebar is part of the layout and none of this does anything: the
 * toggle is not drawn, `open` is never true. Below it, the sidebar is a dialog the toggle
 * opens, and the frame (`shell.tsx`) puts it in one. What lives here is the state both ends
 * share and the three rules that keep a keyboard user oriented:
 *
 * - **Choosing somewhere closes it, and focus goes to the page**, not back to the toggle:
 *   the person asked to be somewhere else, and the toggle is where they were.
 * - **Closing any other way returns focus to the toggle** that opened it.
 * - **Widening the window closes it**, so a sidebar that is part of the layout again is
 *   never also an open, trapped overlay.
 *
 * Outside a provider (a screen mounted alone, as a test does) the toggle is not drawn and the
 * state is closed: a header does not need to know whether it has a sidebar to open.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { IconButton } from '../../ui/icon-button';
import { MAIN_ID } from '../../ui/main';
import { NarrowPortContext, useNarrow } from './narrow';

interface Nav {
  readonly narrow: boolean;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The id of the overlay, for `aria-controls`. */
  readonly panelId: string;
  readonly toggle: React.RefObject<HTMLButtonElement | null>;
  /** Set when the overlay closes because the person chose a place: focus then goes to the page. */
  readonly arrived: React.RefObject<boolean>;
}

const NavContext = createContext<Nav | null>(null);

export const NavProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const narrow = useNarrow(useContext(NarrowPortContext));
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement | null>(null);
  const arrived = useRef(false);
  const { pathname } = useRoute();
  const lastPath = useRef(pathname);

  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (open) {
      arrived.current = true;
      setOpen(false);
    }
  }, [pathname, open]);

  useEffect(() => {
    if (!narrow && open) setOpen(false);
  }, [narrow, open]);

  const value = useMemo<Nav>(
    () => ({ narrow, open: narrow && open, setOpen, panelId, toggle, arrived }),
    [narrow, open, panelId],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
};

/** Where focus goes when the overlay closes: the page after a choice, the toggle otherwise. */
export const returnFocus = (nav: Nav): void => {
  if (nav.arrived.current) {
    nav.arrived.current = false;
    document.getElementById(MAIN_ID)?.focus();
    return;
  }
  nav.toggle.current?.focus();
};

export const useNav = (): Nav | null => useContext(NavContext);

/**
 * The button that opens the sidebar, for a screen's header. Drawn only on a narrow window
 * (`max-narrow:`), and then at the touch size; on a wide one it takes no room at all.
 */
export const NavToggle = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const nav = useNav();
  if (nav === null) return null;
  return (
    <span className="hidden max-narrow:flex">
      <IconButton
        ref={nav.toggle}
        glyph="menu"
        label={t('nav.open')}
        aria-expanded={nav.open}
        aria-controls={nav.panelId}
        aria-haspopup="dialog"
        onClick={() => {
          nav.setOpen(true);
        }}
      />
    </span>
  );
};
