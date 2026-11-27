/**
 * Which rows of a list arrived while it was on screen, so each can be drawn arriving (`animate-arrive`) once.
 *
 * The rows there when the list first had data are not arrivals: a screen that opens with every row rising would
 * shiver on every visit. An id first seen after that is one, until its arrival has played; then it is an ordinary
 * row, so a row drawn again (a tab changed and back) does not arrive a second time.
 *
 * The caller spreads what `arrival(id)` returns on the row and gives the row `data-arrived:animate-arrive`, so
 * its class list stays its own.
 */
import { useRef } from 'react';

export interface ArrivalProps {
  readonly 'data-arrived'?: '';
  readonly onAnimationEnd?: (event: React.AnimationEvent<HTMLElement>) => void;
}

/** The last of the arrival's two animations: when it ends, the row has arrived. */
const LAST = 'arrive-glow';

const NONE: ArrivalProps = {};

/**
 * `ids`: the list's rows in order, or `undefined` while it has no data yet (so the first data is not an arrival).
 * `scope`: what the list is showing, as a filter is; rows that appear because it changed did not arrive, so a new
 * scope starts again from the rows it first shows.
 */
export const useArrivals = (
  ids: readonly string[] | undefined,
  scope = '',
): ((id: string) => ArrivalProps) => {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const shown = useRef(scope);
  if (shown.current !== scope) {
    shown.current = scope;
    seen.current = null;
    fresh.current.clear();
  }
  if (ids !== undefined) {
    if (seen.current === null) {
      seen.current = new Set(ids);
    } else {
      for (const id of ids) {
        if (seen.current.has(id)) continue;
        seen.current.add(id);
        fresh.current.add(id);
      }
    }
  }
  return (id) =>
    fresh.current.has(id)
      ? {
          'data-arrived': '',
          onAnimationEnd: (event): void => {
            if (event.target !== event.currentTarget || event.animationName !== LAST) return;
            fresh.current.delete(id);
            event.currentTarget.removeAttribute('data-arrived');
          },
        }
      : NONE;
};
