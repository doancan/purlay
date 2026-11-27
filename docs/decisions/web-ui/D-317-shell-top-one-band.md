# D-317. The shell's top is one band: the rail, the sidebar and the header start on the same line — amends D-209, D-206

*Amended by D-346: the workspace's row in the band is one line; the role and member count moved into the workspace menu.*

**Decided by the owner, 2026-11-19**, after a live review of the shell's alignment. The rail and the sidebar began below a 28px empty strip kept for a desktop shell's window buttons (D-14), so the first place of the rail and the workspace's row sat at y≈52 while the header beside them is 48px tall with its centre at 24: the first row of the sidebar straddled the line the header ends on, and every browser paid 28px of nothing for a shell that does not exist yet.

**What changes.** The strip and its token `size-drag` are gone. The sidebar opens with a band as tall as the header (`h-header`) that ends on the same hairline: in it the workspace's row (mark, name, role and member count, and the sidebar options), without the frame and the shadow D-209 gave the card — the band is the frame, and hover and open keep the edge's grammar (D-188). In Settings the same band holds the title. The rail's first place now sits level with both (centre at 24). The skeleton draws the same band, and the first-response test finds its header by `data-skeleton-header` since the band comes before it in the document.

**Rejected.** Keeping the strip behind a flag for the desktop: there is no desktop shell and no way to tell that one is the host, so the flag would guard nothing; when the shell is built (D-14) it adds its own inset where it can name its window. Making the card 48px tall to fill the band: a card that fills its band has no room to breathe and is read as a bar.

**Cost of reversing.** Restore the token and the strip in `sidebar.tsx`, `rail.tsx`, `settings-nav.tsx` and the skeleton; no stored value or contract depends on it.
