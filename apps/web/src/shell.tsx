/**
 * The application shell — everything that is true before any screen exists.
 *
 * Deliberately almost nothing. Design tokens (#137), headless primitives (#138)
 * and the first real screen (#23) each arrive with their own issue; a shell that
 * anticipates them would be inventing decisions those issues exist to make.
 *
 * What it does carry is the one thing worth proving now: that the styling layer
 * is actually applying, not merely installed.
 */
export const Shell = (): React.JSX.Element => (
  <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-slate-950 text-slate-100">
    <h1 className="text-2xl font-semibold tracking-tight">Purlay</h1>
    <p className="text-sm text-slate-400">The client boots. Nothing else yet.</p>
  </main>
);
