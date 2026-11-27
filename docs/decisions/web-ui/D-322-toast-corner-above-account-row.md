# D-322. A toast stays in its corner, above the account row — builds on D-211

**Decided by the owner, 2026-11-19**, from a live review of v0.7.1 (#1478). D-211 puts a toast in its corner, "where the eye is not". On a desktop that corner is the sidebar's bottom-left, where the account row is, so *Link copied* and *Scheduled message cancelled* covered the person's name and the account menu for as long as they were up. The stack now sits one account row (64px) higher on a wide window; on a narrow one, where the sidebar is an overlay, it stays at the edge.

**Rejected.** The bottom centre: it is where the eye is, over the composer's hints. The bottom right: over Send and Send later, the controls a toast most often follows. Moving the account row: it is the sidebar's anchor (D-209).

**Cost of reversing.** One utility class in `ui/toast.tsx`.
