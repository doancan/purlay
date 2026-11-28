/**
 * The release moment: opening a new version's notes asks the screen for confetti.
 *
 * A tiny listener set rather than context: the dialog is far from the frame that draws it, and nothing
 * else needs to hear it. Confetti is for releases only — a 🎉 in a message or a reaction no longer sets
 * anything off, so a feed full of them never turns the screen into a show.
 */
const listeners = new Set<() => void>();

/** Asks for confetti. */
export const celebrate = (): void => {
  for (const listener of listeners) listener();
};

/** Calls `listener` on each celebration until the returned function is called. */
export const onCelebrate = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
