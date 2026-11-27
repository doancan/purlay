# D-51. Desktop and mobile are the same client in a shell, and the bar is polish rather than nativeness

**Amended 2026-10-26 by D-186:** macOS now gets a native Swift client in its own repository, and the Tauri shell
is dropped. Mobile as an installable web application, and the web client for Windows and Linux, stand as written
below; "native Swift clients are not planned" no longer does for macOS.

The quality bar was set by naming two groups: Vercel, Supabase and GitHub for interface quality,
and Microsoft, Adobe and Google for the macOS and iOS applications. Those halves pull apart, and
the tension is worth recording rather than resolving quietly.

**None of the three interface exemplars ships a native macOS application.** Vercel does not.
Supabase does not. GitHub Desktop is a web technology shell. They reached that interface quality
partly *because* they concentrated on one client. Adobe, on the other side, has tens of thousands
of employees.

**Decided: one client, wrapped. The bar is polish, not platform nativeness.**

- **Desktop:** the Tauri shell already scheduled for Phase 3 (D-14) — a real application bundle, a
  dock badge, a global shortcut, native notifications, remembered window state.
- **Mobile:** an installable progressive web application. iOS has supported installation and web
  push since 16.4, which covers what a chat client actually needs.
- **Native Swift clients are not planned.** Not "later" — not planned, until a measurement says
  otherwise.

**Why this is a decision and not a deferral.** Polish and nativeness look like the same road with
different lengths, and they are not. Native clients require a second design system, a second
release channel, App Store review, platform expertise and permanent maintenance — and they require
choosing that **now**, because it changes how the API contract and the design system are shaped
from the first component. Deciding it in Phase 3 is not deciding it; it is discovering that the
first two phases were built for something else.

**Said plainly: a web-technology shell does not feel native, and it will not.** That is exactly why
Teams is criticised on macOS. This decision accepts that trade in exchange for one client that is
excellent, which is the trade the interface exemplars all made.

**Trigger to revisit:** paying customers asking for it, with numbers. At that point it is a
business decision with revenue behind it (D-1), not an engineering preference.

**Consistent with:** D-1's stated size — a small operation funded by its users — and D-2's
*subtract before adding*. Three clients maintained by one person is the most reliable way to have
three mediocre clients.
