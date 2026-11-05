/**
 * The party popper's moment: a message that carries 🎉, or a 🎉 reaction one adds, asks the screen for fireworks.
 *
 * A tiny listener set rather than context: the composer and the reaction chips are far from the frame
 * that draws it, and nothing else needs to hear it. Only what *this person* sent celebrates — a feed
 * full of other people's 🎉 never turns the screen into a show.
 */
export const PARTY_POPPER = '🎉';

/** How big a moment is: a 🎉 is a small show; a release opening is one grand one (D-261). */
export type Celebration = 'small' | 'grand';

const listeners = new Set<(size: Celebration) => void>();

export const hasPartyPopper = (text: string): boolean => text.includes(PARTY_POPPER);

/**
 * Asks for fireworks: a small show for a 🎉, or one grand one — two shows' bursts and the sides of a wide
 * screen, a few seconds long — for a bigger moment, a new release opening (D-261).
 */
export const celebrate = (size: Celebration = 'small'): void => {
  for (const listener of listeners) listener(size);
};

/** Calls `listener` on each celebration until the returned function is called. */
export const onCelebrate = (listener: (size: Celebration) => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
