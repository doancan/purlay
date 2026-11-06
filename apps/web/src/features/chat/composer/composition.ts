/**
 * Whether a key belongs to an IME composition (a Japanese or Chinese candidate being chosen), for every box
 * people write in — the composer and the editor of a sent message — so there is one answer (D-188).
 *
 * The flag is kept by native listeners, not React props: React only wires composition events where the
 * engine advertises `CompositionEvent`, and the answer must not depend on that.
 */
import { useEffect, useRef } from 'react';

/** The flag the composition events keep, for `endsComposition`. */
export const useComposition = (
  field: React.RefObject<HTMLTextAreaElement | null>,
): React.RefObject<boolean> => {
  const composing = useRef(false);
  useEffect(() => {
    const element = field.current;
    if (element === null) return undefined;
    const start = (): void => {
      composing.current = true;
    };
    const end = (): void => {
      // Safari fires the keydown that ends a composition *after* compositionend, so the
      // flag is cleared a turn later, once that key has been seen and ignored.
      window.setTimeout(() => {
        composing.current = false;
      }, 0);
    };
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    return (): void => {
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
    };
  }, [field]);
  return composing;
};

/**
 * A key that ends or belongs to a composition is not the person pressing it: the event says so itself,
 * an engine that reports `Process` says so with the key, and one that fires `compositionend` first
 * (Safari) is covered by the flag.
 */
export const duringComposition = (
  event: React.KeyboardEvent,
  composing: React.RefObject<boolean>,
): boolean => event.nativeEvent.isComposing || event.key === 'Process' || composing.current;
