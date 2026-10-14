/**
 * Which thread is open in the panel in this channel visit, and the keys that act on threads
 * (`UX.md` §4, §7; D-122).
 *
 * **One thread at a time, beside the feed.** The panel shows one root's thread; opening another
 * replaces it. **Which one belongs to the screen**, not to the cache or the server: the provider
 * sits inside the channel view, which is keyed by the channel, so the panel is closed when the
 * channel changes and again when the person comes back — unless the address asks for one
 * (`?thread=`).
 *
 * **Two contexts, on purpose.** What can be *done* (`useThreads`) is stable for the life of the
 * channel — functions that read the latest state through a ref — so the fifty rows of a channel,
 * each offering a Reply button, are not re-rendered when a thread opens. What is *open*
 * (`useThreadView`, `useOpenThread`) changes, and is read by the row it marks and the panel.
 *
 * **Focus follows the panel** (`UX.md` §7): opening moves focus into it — its heading, or the
 * reply box when the person asked to reply — and closing puts it back on the root's row in the
 * feed, so a keyboard user is never left on something that has gone.
 *
 * **Keys act on the focused message** and only there: on a row, or inside the panel. `T` and `R`
 * are single keys and so never fire while someone is typing; Resolve (⌘⇧R) and Esc are the two a
 * person reaches for from inside the reply box, so those work there.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MAIN_ID } from '../../ui/main';
import { foldAway } from './collapse';

/** What a root's row lets the keyboard and the panel do to its thread. */
interface ThreadControls {
  /** Only a root that has replies has a thread to show or resolve. */
  readonly hasReplies: () => boolean;
  readonly toggleResolution: () => void;
}

/** Where focus goes when the panel has opened. */
type PanelFocus = 'panel' | 'reply';

/** What the screen can do about threads. Stable for the life of the channel view. */
interface ThreadsApi {
  /** Opens a root's thread in the panel and moves focus into it, or keeps it where it is. */
  readonly open: (rootId: string, focus?: PanelFocus | 'none') => void;
  /** Closes the panel and puts focus back on the root's row in the feed. */
  /** Closes the panel; focus goes back to the root's row unless what closed it takes focus itself. */
  readonly close: (options?: { readonly restoreFocus?: boolean }) => void;
  /** Resolved from here: folds the open thread away with the product's one animation, then closes it. */
  readonly settle: (rootId: string) => Promise<void>;
  /** The panel's body, which `settle` folds. */
  readonly body: React.RefObject<HTMLElement | null>;
  /** The focus the panel was opened with has been given: the request is spent. */
  readonly clearFocusRequest: () => void;
  readonly register: (rootId: string, controls: ThreadControls) => () => void;
  /** Resolve or reopen a root's thread, by the controls its row registered. */
  readonly toggleResolution: (rootId: string) => void;
  /** Handles a key pressed on a row or in the panel; true when it was this slice's. */
  readonly handleKey: (event: React.KeyboardEvent) => boolean;
}

interface ThreadsState {
  readonly openId: string | null;
  /** Where focus should go now that the panel is open, until it has. */
  readonly focusRequest: PanelFocus | null;
}

const ThreadsContext = createContext<ThreadsApi | null>(null);
const StateContext = createContext<ThreadsState>({ openId: null, focusRequest: null });

export const useThreads = (): ThreadsApi => {
  const api = useContext(ThreadsContext);
  if (api === null) throw new Error('useThreads was called outside a ThreadsProvider');
  return api;
};

/** The thread open in the panel, and where focus is to go in it. */
export const useOpenThread = (): ThreadsState => useContext(StateContext);

/** Whether one root's thread is the one open in the panel. */
export const useThreadView = (rootId: string): boolean =>
  useContext(StateContext).openId === rootId;

/** The root's own row in the channel's feed — not its copy at the top of the panel. */
const feedRowOf = (rootId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[role="feed"] [data-message-row][data-message-id="${rootId}"]`,
  );

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches('input, textarea, select') || target.isContentEditable);

export interface ThreadsProviderProps {
  /** A thread to open when the channel does (the open-questions view and the inbox link to one). */
  readonly openThread?: string | null | undefined;
  readonly children: React.ReactNode;
}

export const ThreadsProvider = ({
  openThread = null,
  children,
}: ThreadsProviderProps): React.JSX.Element => {
  // A thread the address opens takes focus like one opened by hand: on a narrow window the panel
  // covers the composer that would otherwise have it.
  const [state, setState] = useState<ThreadsState>({
    openId: openThread,
    focusRequest: openThread === null ? null : 'panel',
  });
  const latest = useRef(state.openId);
  latest.current = state.openId;
  const controls = useRef(new Map<string, ThreadControls>());
  const body = useRef<HTMLElement>(null);
  const returnTo = useRef<string | null>(null);
  // What had focus when the panel opened: where it goes back when the root has no row in the feed.
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback((rootId: string, focus: PanelFocus | 'none' = 'panel'): void => {
    const active = document.activeElement;
    if (latest.current === null) {
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setState({ openId: rootId, focusRequest: focus === 'none' ? null : focus });
  }, []);

  const close = useCallback((options?: { readonly restoreFocus?: boolean }): void => {
    const was = latest.current;
    if (was === null) return;
    latest.current = null;
    returnTo.current = options?.restoreFocus === false ? null : was;
    setState({ openId: null, focusRequest: null });
  }, []);

  // Focus goes back to the root once the panel has gone: on a narrow window the conversation is
  // hidden under the panel until then, and a hidden row cannot take focus.
  // A root with no row there — opened from the files panel, the inbox or an address, older than what
  // the feed holds — sends it to what opened the panel, if that is still on the page, or else to the
  // main region: never to nothing (#555).
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (state.openId !== null || id === null) return;
    returnTo.current = null;
    const back = opener.current?.isConnected === true ? opener.current : null;
    opener.current = null;
    (feedRowOf(id) ?? back ?? document.getElementById(MAIN_ID))?.focus();
  }, [state.openId]);

  const settle = useCallback(
    async (rootId: string): Promise<void> => {
      if (latest.current !== rootId) return;
      if (body.current !== null) await foldAway(body.current);
      if (latest.current === rootId) close();
    },
    [close],
  );

  const register = useCallback((rootId: string, entry: ThreadControls): (() => void) => {
    controls.current.set(rootId, entry);
    return (): void => {
      if (controls.current.get(rootId) === entry) controls.current.delete(rootId);
    };
  }, []);
  const toggleResolution = useCallback((rootId: string): void => {
    controls.current.get(rootId)?.toggleResolution();
  }, []);
  const clearFocusRequest = useCallback((): void => {
    setState((current) =>
      current.focusRequest === null ? current : { ...current, focusRequest: null },
    );
  }, []);

  const handleKey = useCallback(
    (event: React.KeyboardEvent): boolean => {
      const target = event.target as HTMLElement;
      const inPanel = target.closest<HTMLElement>('[data-thread-root]');
      const row = target.closest<HTMLElement>('[data-message-row]');
      const rootId = inPanel?.dataset['threadRoot'] ?? row?.dataset['messageId'];
      if (rootId === undefined) return false;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape') {
        // In the panel, Esc closes it and returns to the root (`UX.md` §7: the topmost thing).
        // On the root's own row, with its thread open beside it, the thread is still the topmost
        // thing, so Esc there closes it too; on any other row Esc is the feed's.
        if (inPanel === null && latest.current !== rootId) return false;
        event.preventDefault();
        close();
        return true;
      }
      if (key === 'r' && event.shiftKey && (event.metaKey || event.ctrlKey) && !event.altKey) {
        // The browser's hard reload would take the page with it; resolving is this key's meaning here.
        event.preventDefault();
        controls.current.get(rootId)?.toggleResolution();
        return true;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return false;
      }
      if (key === 't') {
        if (inPanel === null && controls.current.get(rootId)?.hasReplies() !== true) return false;
        event.preventDefault();
        open(rootId, 'panel');
        return true;
      }
      if (key === 'r') {
        // A reply has no thread of its own (I-1): R on one in the panel answers its root. In the
        // feed only a sent root registers controls; one still sending, or failed, has no thread yet.
        if (inPanel === null && !controls.current.has(rootId)) return false;
        event.preventDefault();
        open(rootId, 'reply');
        return true;
      }
      return false;
    },
    [close, open],
  );

  const api = useMemo<ThreadsApi>(
    () => ({
      open,
      close,
      settle,
      body,
      clearFocusRequest,
      register,
      toggleResolution,
      handleKey,
    }),
    [open, close, settle, clearFocusRequest, register, toggleResolution, handleKey],
  );

  return (
    <ThreadsContext.Provider value={api}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ThreadsContext.Provider>
  );
};
