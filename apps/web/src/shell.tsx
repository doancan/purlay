/**
 * The application shell — everything that is true before any screen exists.
 *
 * Deliberately almost nothing. Headless primitives (#138) and the first real screen
 * (#23) each arrive with their own issue; a shell that anticipates them would be
 * inventing decisions those issues exist to make.
 *
 * What it does carry is the one thing worth proving now: that the styling layer is
 * applying *and speaking the token vocabulary* — every class below is a token, and
 * `styles.test.ts` fails if one stops being.
 */
export const Shell = (): React.JSX.Element => (
  <main className="flex h-screen flex-col items-center justify-center gap-2 bg-surface-100 text-ink">
    <h1 className="text-display">Purlay</h1>
    <p className="text-body text-ink-muted">The client boots. Nothing else yet.</p>
  </main>
);
