/**
 * Which of the application's two overlays is open: the command palette, the shortcut list, or
 * neither (`UX.md` §7).
 *
 * The state used to live inside `GlobalKeys`, which was enough while the only way to open the
 * palette was `Cmd/Ctrl+K`. The sidebar's jump field is a second door to the same room, and it is
 * a sibling of `GlobalKeys`, not a child — so the state moved up to where both can reach it, and
 * there is still exactly one place that says what is open. Outside a provider (a screen mounted
 * alone, as a test does) there is no door to draw: `useOverlayDoor` returns `null`, and a caller
 * draws nothing rather than a button that does nothing.
 */
import { createContext, useContext, useMemo, useState } from 'react';

type Overlay = 'palette' | 'shortcuts' | null;

interface OverlayState {
  readonly overlay: Overlay;
  readonly setOverlay: (next: Overlay | ((now: Overlay) => Overlay)) => void;
}

const OverlayContext = createContext<OverlayState | null>(null);

export const OverlayProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const value = useMemo<OverlayState>(() => ({ overlay, setOverlay }), [overlay]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
};

/** The state itself, for the one component that renders the overlays and owns their keys. */
export const useOverlay = (): OverlayState => {
  const shared = useContext(OverlayContext);
  const [own, setOwn] = useState<Overlay>(null);
  // A `GlobalKeys` mounted alone keeps its own state, as it always did.
  return shared ?? { overlay: own, setOverlay: setOwn };
};

/** A function that opens the palette, or `null` where nothing renders one. */
export const useOverlayDoor = (): (() => void) | null => {
  const state = useContext(OverlayContext);
  return useMemo(
    () =>
      state === null
        ? null
        : (): void => {
            state.setOverlay('palette');
          },
    [state],
  );
};

/** A function that opens the shortcut reference, or `null` where nothing renders it. */
export const useShortcutsDoor = (): (() => void) | null => {
  const state = useContext(OverlayContext);
  return useMemo(
    () =>
      state === null
        ? null
        : (): void => {
            state.setOverlay('shortcuts');
          },
    [state],
  );
};
