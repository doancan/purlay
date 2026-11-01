/**
 * The party popper's moment: a message that carries 🎉, or a 🎉 reaction one adds, asks the screen for fireworks.
 *
 * A tiny listener set rather than context: the composer and the reaction chips are far from the frame
 * that draws it, and nothing else needs to hear it. Only what *this person* sent celebrates — a feed
 * full of other people's 🎉 never turns the screen into a show.
 */
export const PARTY_POPPER = '🎉';

const listeners = new Set<() => void>();

export const hasPartyPopper = (text: string): boolean => text.includes(PARTY_POPPER);

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
