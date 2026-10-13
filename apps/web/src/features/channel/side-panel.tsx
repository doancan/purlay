/**
 * Which panel, other than a thread, is open beside the conversation in this channel visit (D-129).
 *
 * **One panel at a time.** The right-hand side holds a thread or a channel's list, never both:
 * opening the list closes the thread, and a thread opening — Reply, `T`, an address — closes the
 * list. Like the thread, which one is open belongs to the visit: the provider sits inside the
 * channel view, which is keyed by the channel.
 *
 * **Focus follows the panel** (`UX.md` §7): opening moves it to the panel's heading, closing puts
 * it back on the header's control that opened it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOpenThread, useThreads } from '../threads/thread-context';

/** The panels a channel has besides a thread. */
export type SidePanelName = 'files';

interface SidePanelApi {
  readonly panel: SidePanelName | null;
  readonly open: (panel: SidePanelName) => void;
  readonly close: () => void;
}

const SidePanelContext = createContext<SidePanelApi | null>(null);

export const useSidePanel = (): SidePanelApi => {
  const api = useContext(SidePanelContext);
  if (api === null) throw new Error('useSidePanel was called outside a SidePanelProvider');
  return api;
};

/** The header's control for a panel, where focus goes back to when the panel closes. */
export const panelToggleOf = (panel: SidePanelName): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-panel-toggle="${panel}"]`);

export const SidePanelProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const threads = useThreads();
  const { openId } = useOpenThread();
  const [panel, setPanel] = useState<SidePanelName | null>(null);
  const returnTo = useRef<SidePanelName | null>(null);

  // A thread opening takes the side: the list gives way, and focus is the thread's.
  useEffect(() => {
    if (openId !== null) setPanel(null);
  }, [openId]);

  const open = useCallback(
    (next: SidePanelName): void => {
      if (openId !== null) threads.close();
      returnTo.current = null;
      setPanel(next);
    },
    [openId, threads],
  );

  const close = useCallback((): void => {
    setPanel((current) => {
      returnTo.current = current;
      return null;
    });
  }, []);

  // Back to the control that opened it, once the panel has gone: on a narrow window the header is
  // hidden under the panel until then.
  useLayoutEffect(() => {
    const was = returnTo.current;
    if (panel !== null || was === null) return;
    returnTo.current = null;
    panelToggleOf(was)?.focus();
  }, [panel]);

  const api = useMemo<SidePanelApi>(() => ({ panel, open, close }), [panel, open, close]);
  return <SidePanelContext.Provider value={api}>{children}</SidePanelContext.Provider>;
};
