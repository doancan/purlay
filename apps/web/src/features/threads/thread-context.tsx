/**
 * Which threads are open in this channel visit, and the keys that act on them
 * (`UX.md` §4, §7).
 *
 * **Expansion belongs to the screen**, not to the cache or the server: it is where the
 * person is looking. The provider sits inside the feed, which is keyed by the channel, so
 * every thread is collapsed when the channel changes and again when the person comes back —
 * a thread opened last week is not one to find open today.
 *
 * **Two contexts, on purpose.** What can be *done* (`useThreads`) is stable for the life of
 * the feed — functions that read the latest state through a ref — so the fifty rows of a
 * channel, each offering a Reply button, are not re-rendered when one thread opens. What is
 * *open* (`useThreadView`) changes, and is read only by the thread it is about.
 *
 * **The root does not move.** Opening or closing a thread changes the height of what is
 * below the root it belongs to, and the feed's rule of sticking to the bottom (or the
 * browser's own anchoring) would answer by moving the root. Every change records where the
 * root's row is first and puts it back after the layout, and tells the feed it is no longer
 * "at the bottom" so it does not scroll to follow the growth (`UX.md` §6: expanding a
 * thread anchors on the root).
 *
 * **Keys act on the focused message** and only there: on a row, or inside its thread. `T`
 * and `R` are single keys and so never fire while someone is typing; Resolve (⌘⇧R) and Esc
 * are the two a person reaches for from inside the reply box, so those work there.
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

/** What a thread lets the keyboard do to it. */
interface ThreadControls {
  /** Only a root that has replies has a thread to show, hide or resolve. */
  readonly hasReplies: () => boolean;
  readonly toggleResolution: () => void;
}

/** What the screen can do about threads. Stable for the life of the feed. */
interface ThreadsApi {
  readonly toggle: (rootId: string) => void;
  /** Opens a thread; with `focusReply` the reply box takes focus once it is there. */
  readonly expand: (rootId: string, options?: { readonly focusReply?: boolean }) => void;
  readonly collapse: (rootId: string) => void;
  /** The feed's scrolling element. */
  readonly scroller: React.RefObject<HTMLElement | null>;
  /** The reply box has taken focus (or there was nothing to take it): the request is spent. */
  readonly clearReplyRequest: () => void;
  readonly register: (rootId: string, controls: ThreadControls) => () => void;
  /** Handles a key pressed in the feed; true when it was this slice's. */
  readonly handleKey: (event: React.KeyboardEvent) => boolean;
}

interface ThreadsState {
  readonly expanded: ReadonlySet<string>;
  /** The root whose reply box should take focus now, until it has. */
  readonly replyRequest: string | null;
}

const ThreadsContext = createContext<ThreadsApi | null>(null);
const StateContext = createContext<ThreadsState>({ expanded: new Set(), replyRequest: null });

export const useThreads = (): ThreadsApi => {
  const api = useContext(ThreadsContext);
  if (api === null) throw new Error('useThreads was called outside a ThreadsProvider');
  return api;
};

/** Whether one root's thread is open, and whether its reply box has been asked for. */
export const useThreadView = (
  rootId: string,
): { readonly expanded: boolean; readonly replyRequested: boolean } => {
  const { expanded, replyRequest } = useContext(StateContext);
  return { expanded: expanded.has(rootId), replyRequested: replyRequest === rootId };
};

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches('input, textarea, select') || target.isContentEditable);

export interface ThreadsProviderProps {
  /** The feed's scrolling element, whose scroll position is kept steady. */
  readonly scroller: React.RefObject<HTMLElement | null>;
  /** Tells the feed the reader is deliberately not following the bottom. */
  readonly holdPlace: () => void;
  /** A thread to open when the channel does (the open-questions view links to one). */
  readonly openThread?: string | null | undefined;
  readonly children: React.ReactNode;
}

export const ThreadsProvider = ({
  scroller,
  holdPlace,
  openThread = null,
  children,
}: ThreadsProviderProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(openThread === null ? [] : [openThread]),
  );
  const [replyRequest, setReplyRequest] = useState<string | null>(null);
  const latest = useRef(expanded);
  latest.current = expanded;
  const controls = useRef(new Map<string, ThreadControls>());
  const anchor = useRef<{ readonly id: string; readonly top: number } | null>(null);
  const reveal = useRef(openThread);

  const rowOf = useCallback(
    (rootId: string): HTMLElement | null =>
      scroller.current?.querySelector<HTMLElement>(
        `[data-message-row][data-message-id="${rootId}"]`,
      ) ?? null,
    [scroller],
  );

  const change = useCallback(
    (rootId: string, open: boolean): void => {
      if (latest.current.has(rootId) === open) return;
      const row = rowOf(rootId);
      if (row !== null) anchor.current = { id: rootId, top: row.getBoundingClientRect().top };
      holdPlace();
      setExpanded((current) => {
        const next = new Set(current);
        if (open) next.add(rootId);
        else next.delete(rootId);
        return next;
      });
    },
    [rowOf, holdPlace],
  );

  // After the layout that follows an open or a close, give the root back its place.
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    const el = scroller.current;
    if (held === null || el === null) return;
    const row = rowOf(held.id);
    if (row === null) return;
    el.scrollTop += row.getBoundingClientRect().top - held.top;
  }, [expanded, scroller, rowOf]);

  // A thread asked for by the address is brought into view once its row is on screen.
  useEffect(() => {
    if (reveal.current === null) return;
    const row = rowOf(reveal.current);
    if (row === null) return;
    reveal.current = null;
    // The reader was at the bottom when the feed opened, and the feed follows the bottom while the
    // box around it changes size: without letting go first, the resize that comes with the thread
    // opening and the older pages above it carries the reader straight back down, out of sight of
    // the thing the link was for (found in a browser, in a channel with a hundred messages).
    holdPlace();
    row.scrollIntoView({ block: 'center' });
  });

  const expand = useCallback(
    (rootId: string, options?: { readonly focusReply?: boolean }): void => {
      change(rootId, true);
      if (options?.focusReply === true) setReplyRequest(rootId);
    },
    [change],
  );
  const collapse = useCallback(
    (rootId: string): void => {
      change(rootId, false);
    },
    [change],
  );
  const toggle = useCallback(
    (rootId: string): void => {
      change(rootId, !latest.current.has(rootId));
    },
    [change],
  );
  const register = useCallback((rootId: string, entry: ThreadControls): (() => void) => {
    controls.current.set(rootId, entry);
    return (): void => {
      controls.current.delete(rootId);
    };
  }, []);
  const clearReplyRequest = useCallback((): void => {
    setReplyRequest(null);
  }, []);

  const handleKey = useCallback(
    (event: React.KeyboardEvent): boolean => {
      const target = event.target as HTMLElement;
      const inThread = target.closest<HTMLElement>('[data-thread-root]');
      const row = target.closest<HTMLElement>('[data-message-row]');
      const rootId = inThread?.dataset['threadRoot'] ?? row?.dataset['messageId'];
      if (rootId === undefined) return false;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape') {
        // Out of a thread: fold it and keep the person on its root. Focus on the root itself counts —
        // the thread is *its* content, so Esc on the question closes the thread under it, which is
        // what "Esc closes the topmost thing" (`UX.md` §7) means when the thread is the topmost thing
        // and the person has not moved into it (found in a browser: T opened it, Esc did not close it).
        if (!latest.current.has(rootId)) return false;
        event.preventDefault();
        collapse(rootId);
        rowOf(rootId)?.focus();
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
        if (controls.current.get(rootId)?.hasReplies() !== true) return false;
        event.preventDefault();
        toggle(rootId);
        return true;
      }
      if (key === 'r') {
        event.preventDefault();
        expand(rootId, { focusReply: true });
        return true;
      }
      return false;
    },
    [collapse, expand, toggle, rowOf],
  );

  const api = useMemo<ThreadsApi>(
    () => ({ toggle, expand, collapse, scroller, clearReplyRequest, register, handleKey }),
    [toggle, expand, collapse, scroller, clearReplyRequest, register, handleKey],
  );
  const state = useMemo<ThreadsState>(() => ({ expanded, replyRequest }), [expanded, replyRequest]);

  return (
    <ThreadsContext.Provider value={api}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ThreadsContext.Provider>
  );
};
