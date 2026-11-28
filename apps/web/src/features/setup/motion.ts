/**
 * The wizard's movements (UX §11): each is a class of `index.css`, played only when the person has not asked for less
 * motion (`ui/reduced-motion.ts`).
 */
/** The movements the wizard has; each is a class of `index.css`. */
export type Movement = 'step-in' | 'step-back' | 'mark-settle' | 'nudge';

const CLASSES: Record<Movement, string> = {
  'step-in': 'animate-step-in',
  'step-back': 'animate-step-back',
  'mark-settle': 'animate-mark-settle',
  nudge: 'animate-nudge',
};

/** The class that plays `movement`, or nothing under reduced motion. */
export const movementClass = (movement: Movement, reduced: boolean): string =>
  reduced ? '' : CLASSES[movement];
