/**
 * The fireworks 🎉 sets off (D-247): rockets climb, then burst into rays and sparks that open slowly and drift down,
 * in the theme's own colours. There are five shows and one is picked each time, never the one just seen.
 *
 * Plain SVG and CSS keyframes (`index.css`), no library and no canvas: the shapes are drawn once, the
 * motion is the stylesheet's, and its length is the `duration-celebrate` token — 0ms under reduced
 * motion, where it is not drawn at all. Delays are fractions of that one length, so a show keeps its
 * shape whatever the length is. A grand show (a release opening, D-261) folds in a second show and, on a wide
 * screen, the sides, over `duration-celebrate-grand` — one smooth run of about four and a half seconds, then gone. It sits over everything, takes no pointer and is hidden from assistive
 * technology: it is a flourish, never information. It removes itself when its last burst ends.
 */
import { useEffect, useState } from 'react';
import { onCelebrate } from './celebrate';

interface Burst {
  /** Where it opens, in the 100 x 100 field. */
  readonly x: number;
  readonly y: number;
  /** When it opens, as a fraction of the show's length. */
  readonly at: number;
  readonly colour: string;
  readonly rays: number;
  readonly reach: number;
  /** How far its sparks sink while they fade, in `space-1` steps. */
  readonly sink: number;
  /** A second, smaller ring inside the first. */
  readonly ring?: boolean;
}

const ACCENT = 'var(--accent-text)';
const WARM = 'var(--warning)';
const GREEN = 'var(--success)';
const RED = 'var(--danger)';

const burst = (
  x: number,
  y: number,
  at: number,
  colour: string,
  options: Partial<Pick<Burst, 'rays' | 'reach' | 'sink' | 'ring'>> = {},
): Burst => ({ x, y, at, colour, rays: 14, reach: 11, sink: 1, ...options });

/** The five shows. Each is a different rhythm, not the same bursts moved about. */
const SHOWS: readonly (readonly Burst[])[] = [
  // Finale: one big peony, then four answering it.
  [
    burst(50, 30, 0.12, ACCENT, { rays: 18, reach: 16, ring: true }),
    burst(24, 42, 0.3, WARM),
    burst(76, 40, 0.38, GREEN),
    burst(36, 20, 0.46, RED),
    burst(64, 22, 0.52, ACCENT),
  ],
  // Fan: three side by side, rising together, opening in order from the left.
  [
    burst(28, 32, 0.14, WARM, { rays: 16, reach: 13 }),
    burst(50, 24, 0.22, ACCENT, { rays: 20, reach: 15, ring: true }),
    burst(72, 32, 0.3, GREEN, { rays: 16, reach: 13 }),
  ],
  // Willow: slow, wide, with sparks that sink a long way.
  [
    burst(50, 26, 0.12, WARM, { rays: 22, reach: 18, sink: 4 }),
    burst(30, 36, 0.36, ACCENT, { rays: 16, reach: 12, sink: 3 }),
    burst(70, 36, 0.44, GREEN, { rays: 16, reach: 12, sink: 3 }),
  ],
  // Cascade: six small ones, left to right, like a line being lit.
  [
    burst(14, 40, 0.1, RED, { reach: 8 }),
    burst(30, 30, 0.18, WARM, { reach: 8 }),
    burst(46, 38, 0.26, GREEN, { reach: 8 }),
    burst(62, 28, 0.34, ACCENT, { reach: 8 }),
    burst(78, 38, 0.42, RED, { reach: 8 }),
    burst(90, 30, 0.5, WARM, { reach: 8 }),
  ],
  // Crown: a ringed centre that opens twice, with a crown of small ones above it.
  [
    burst(50, 42, 0.1, ACCENT, { rays: 20, reach: 15, ring: true }),
    burst(50, 42, 0.34, WARM, { rays: 12, reach: 9 }),
    burst(30, 18, 0.42, GREEN, { reach: 8 }),
    burst(50, 12, 0.48, RED, { reach: 8 }),
    burst(70, 18, 0.54, GREEN, { reach: 8 }),
  ],
];

const PALETTE = [ACCENT, WARM, GREEN, RED];

/**
 * The extra bursts of a bigger moment on a wide screen (a release opening, D-261): two out to the left of the
 * middle field and two to the right, which the wider view makes room for. Their colours turn with the show, so
 * the sides are never the same twice, and they open among the middle's own bursts.
 */
const flanksFor = (show: number): readonly Burst[] => [
  burst(-20, 36, 0.2, PALETTE[(show + 1) % 4] ?? ACCENT, { rays: 16, reach: 13, ring: true }),
  burst(-8, 20, 0.4, PALETTE[(show + 2) % 4] ?? WARM, { reach: 10 }),
  burst(108, 22, 0.28, PALETTE[(show + 3) % 4] ?? GREEN, { reach: 10 }),
  burst(120, 38, 0.48, PALETTE[show % 4] ?? RED, { rays: 16, reach: 13, ring: true }),
];

/** Wide enough that the field can reach past the middle: a phone's portrait would only shrink the show. */
const isWide = (): boolean =>
  typeof innerWidth === 'number' && innerHeight > 0 && innerWidth / innerHeight >= 1.3;

/** How far into a grand show its second show begins, as a fraction of the show. */
const ALSO_AFTER = 0.2;

/** Gap between a rocket setting off and its burst, as a fraction of the show. */
const CLIMB = 0.16;

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const fraction = (value: number): string => `calc(var(--duration-celebrate) * ${String(value)})`;

const Ring = ({
  rays,
  reach,
  colour,
}: {
  readonly rays: number;
  readonly reach: number;
  readonly colour: string;
}): React.JSX.Element => (
  <>
    {Array.from({ length: rays }, (_, index) => (
      <g key={index} transform={`rotate(${String((360 / rays) * index)})`}>
        <line y1={reach * 0.35} y2={reach} stroke={colour} className="firework-line" />
        <line y1={reach * 1.12} y2={reach * 1.18} stroke={colour} className="firework-line" />
        <line y1={reach * 1.3} y2={reach * 1.31} stroke={colour} className="firework-line" />
      </g>
    ))}
  </>
);

const BurstShape = ({ burst: b }: { readonly burst: Burst }): React.JSX.Element => (
  <g transform={`translate(${String(b.x)} ${String(b.y)})`}>
    <g
      className="animate-firework-fall"
      style={{
        animationDelay: fraction(b.at),
        ['--sink' as string]: String(b.sink),
      }}
    >
      <g className="animate-firework-burst" style={{ animationDelay: fraction(b.at) }}>
        <Ring rays={b.rays} reach={b.reach} colour={b.colour} />
      </g>
      {b.ring === true && (
        <g className="animate-firework-burst" style={{ animationDelay: fraction(b.at + 0.06) }}>
          <g transform="rotate(10)">
            <Ring rays={Math.round(b.rays / 2)} reach={b.reach * 0.55} colour={b.colour} />
          </g>
        </g>
      )}
    </g>
  </g>
);

const RocketShape = ({ burst: b }: { readonly burst: Burst }): React.JSX.Element => (
  <line
    x1={b.x}
    x2={b.x}
    y1="100"
    y2={b.y}
    stroke={b.colour}
    className="firework-line animate-firework-rocket"
    style={{ animationDelay: fraction(Math.max(0, b.at - CLIMB)) }}
  />
);

/**
 * How long a burst's sparks sink, as a fraction of the show (`animate-firework-fall` in `index.css`): the last
 * burst opens at its `at` and is over `FALL` later, so a run lasts `(last at + FALL)` shows' lengths.
 */
const FALL = 0.55;

/**
 * A grand run's length is the token's, whatever shows it holds: the stylesheet's motion is fractions of
 * `--duration-celebrate`, so that variable is the token over what the run's bursts add up to — the last one to open
 * and the time its sparks take to sink — and every grand show lasts the same smooth four and a half seconds.
 */
const grandLength = (bursts: readonly Burst[]): React.CSSProperties => {
  const span = Math.max(...bursts.map((each) => each.at)) + FALL;
  return {
    ['--duration-celebrate' as string]: `calc(var(--duration-celebrate-grand) / ${span.toFixed(3)})`,
  };
};

export interface FireworksProps {
  /** A number in [0, 1): which show comes up. Injected so a test names the show. */
  readonly random?: () => number;
}

/** The index of the last show seen, so the next one differs. */
let lastShow = -1;

const nextShow = (random: () => number): number => {
  const offset = 1 + Math.floor(random() * (SHOWS.length - 1));
  lastShow =
    lastShow < 0 ? Math.floor(random() * SHOWS.length) : (lastShow + offset) % SHOWS.length;
  return lastShow;
};

export const Fireworks = ({ random = Math.random }: FireworksProps): React.JSX.Element | null => {
  // Each celebration is a new run, so one that lands during another restarts cleanly.
  // A grand run is two shows' bursts at once, over a longer length, with the sides of a wide screen lit too.
  const [run, setRun] = useState<{
    readonly key: number;
    readonly show: number;
    readonly grand: boolean;
    /** Whether the field reaches out to the sides: a grand show on a wide screen. */
    readonly wide: boolean;
    /** The second show a grand run folds in, a different one. */
    readonly also: number | null;
  } | null>(null);

  useEffect(
    () =>
      onCelebrate((size) => {
        if (prefersReducedMotion()) return;
        const show = nextShow(random);
        const grand = size === 'grand';
        setRun((previous) => ({
          key: (previous?.key ?? 0) + 1,
          show,
          grand,
          wide: grand && isWide(),
          also: grand ? nextShow(random) : null,
        }));
      }),
    [random],
  );

  // The sinking sparks are the longest thing a burst does: when the last of those stops, the show is over.
  const endShow = (event: React.AnimationEvent): void => {
    if (event.animationName === 'firework-fall') setRun(null);
  };
  if (run === null) return null;
  // The second show opens a fifth of the way in, so the two answer each other instead of going off together.
  const second = (SHOWS[run.also ?? -1] ?? []).map((each) => ({
    ...each,
    at: each.at + ALSO_AFTER,
  }));
  const bursts = [...(SHOWS[run.show] ?? []), ...second, ...(run.wide ? flanksFor(run.show) : [])];
  // The last to open is the last to finish: its end ends the show.
  const finale = bursts.reduce<Burst | null>((a, b) => (a === null || b.at >= a.at ? b : a), null);
  return (
    <svg
      key={run.key}
      aria-hidden="true"
      focusable="false"
      viewBox={run.wide ? '-30 0 160 100' : '0 0 100 100'}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none fixed inset-0 z-toast size-full"
      data-testid="fireworks"
      data-show={run.show}
      data-grand={run.grand ? 'true' : undefined}
      style={run.grand ? grandLength(bursts) : undefined}
    >
      {bursts.map((each, index) => (
        <g key={index} onAnimationEnd={each === finale ? endShow : undefined}>
          <RocketShape burst={each} />
          <BurstShape burst={each} />
        </g>
      ))}
    </svg>
  );
};
