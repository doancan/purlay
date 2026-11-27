# D-319. A preset that is a span from now says the clock time it comes to — amends D-315, D-316

**Decided by the owner, 2026-11-19**, from a live review of v0.7.1. *Tomorrow at 09:00* and *Monday at 09:00* said when they would happen; *In 20 minutes*, *In 1 hour* and *In 3 hours* said only how long, so a person choosing a time to be reminded or to send at could not see it until the Scheduled list or the Saved tab, after choosing.

**What changes.** The three spans in the Remind me… menu and *In 1 hour* in Send later carry the viewer's clock time in brackets — *In 1 hour (14:00)* — worked out when the menu opens, in the viewer's zone and 24-hour form like the rest of the product's times. What is set is still the span from the moment of choosing, so the minute can differ from the one shown if the menu stayed open.

**Rejected.** Replacing the span with the time (*At 14:00*): people choose "in an hour" by the duration and confirm by the time, so both are shown. A second line under each item: the menu's items are one line everywhere (D-150).

**The shell's bound moves from 258 to 259 KB.** The initial JavaScript measured 258.00 KB at v0.7.1 (257.24 KB at v0.6.4, when D-306 last raised it): the settings menu's marks and the shell's top band (D-317) took the margin, and the labels here bring it to 258.01 KB. One KB is the margin for a feature or two, as every earlier raise was; the 400 KB backstop and the module bounds stay. Nothing was found to cut: every glyph of the set is used, and the labels' code is the smallest that says the time.

**Cost of reversing.** The five message keys and the two labels; no stored value or contract.
