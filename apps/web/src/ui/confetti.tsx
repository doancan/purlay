/**
 * The confetti a new release opens with (D-261): two cannons at the bottom corners throw paper up and
 * inward, and it flutters back down, a few seconds long, then removes itself.
 *
 * Plain DOM and CSS keyframes (`confetti-pop` in `index.css`), no library and no canvas: each piece carries
 * its own path as custom properties and the stylesheet does the motion over the `duration-celebrate` token —
 * not drawn at all under reduced motion. It sits over everything, takes no pointer and is hidden from
 * assistive technology: it is a flourish, never information.
 */
import { prefersReducedMotion } from './reduced-motion';
import { useEffect, useRef, useState } from 'react';
import { onCelebrate } from './celebrate';

const COLOURS = [
  'var(--accent-text)',
  'var(--warning)',
  'var(--success)',
  'var(--danger)',
  'var(--accent)',
] as const;

/** Pieces thrown by each cannon. */
const PIECES_PER_CANNON = 90;

/** The longest a piece waits to leave, as a fraction of its flight: the cannons fire together, not in one thump. */
const MAX_STAGGER = 0.12;

interface Piece {
  readonly colour: string;
  readonly style: Record<string, string>;
}

const between = (random: () => number, low: number, high: number): number =>
  low + random() * (high - low);

const piecesFor = (random: () => number): readonly Piece[] =>
  [-1, 1].flatMap((side) =>
    Array.from({ length: PIECES_PER_CANNON }, (): Piece => {
      // `side` is -1 for the left cannon (its pieces travel right, +x) and 1 for the right.
      const toward = -side;
      const reach = between(random, 8, 46);
      const height = between(random, 38, 88);
      const wide = random() > 0.5;
      return {
        colour: COLOURS[Math.floor(random() * COLOURS.length)] ?? COLOURS[0],
        style: {
          [side === -1 ? 'left' : 'right']: '0',
          '--x1': `${String(toward * reach)}vw`,
          '--y1': `${String(-height)}vh`,
          '--x2': `${String(toward * (reach + between(random, -6, 14)))}vw`,
          '--y2': '8vh',
          '--spin': `${String(between(random, -900, 900))}deg`,
          '--stagger': String(random() * MAX_STAGGER),
          '--flight': String(between(random, 0.78, 1)),
          width: wide ? 'var(--space-2)' : 'var(--space-1)',
          height: wide ? 'var(--space-1)' : 'var(--space-2)',
        },
      };
    }),
  );

export interface ConfettiProps {
  /** A number in [0, 1). Injected so a test names the throw. */
  readonly random?: () => number;
}

export const Confetti = ({ random = Math.random }: ConfettiProps): React.JSX.Element | null => {
  // Each celebration is a new throw, so one that lands during another restarts cleanly.
  const [throwing, setThrowing] = useState<{
    readonly key: number;
    readonly pieces: readonly Piece[];
  } | null>(null);

  // The run is over when the last piece has landed, whichever that is; each landing is counted.
  const landed = useRef(0);

  useEffect(
    () =>
      onCelebrate(() => {
        if (prefersReducedMotion()) return;
        landed.current = 0;
        setThrowing((previous) => ({ key: (previous?.key ?? 0) + 1, pieces: piecesFor(random) }));
      }),
    [random],
  );

  if (throwing === null) return null;
  const landing = (): void => {
    landed.current += 1;
    if (landed.current >= throwing.pieces.length) setThrowing(null);
  };
  return (
    <div
      key={throwing.key}
      aria-hidden="true"
      data-testid="confetti"
      className="pointer-events-none fixed inset-0 z-toast overflow-hidden"
    >
      {throwing.pieces.map((piece, at) => (
        <span
          key={at}
          className="animate-confetti-pop absolute bottom-0 rounded-sm"
          style={{ backgroundColor: piece.colour, ...piece.style }}
          onAnimationEnd={landing}
        />
      ))}
    </div>
  );
};
