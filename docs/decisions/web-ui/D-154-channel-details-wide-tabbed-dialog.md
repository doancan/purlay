# D-154. A channel's details are a wide dialog with tabs, not one long column

**Context.** D-123's details were one 480px dialog holding everything: the name and topic, the
members with Add people, the notification level drawn only as a bell that did not say the level, an
owner's whole GitHub connect form (D-134), and Leave and Archive at the foot. At 900px it was 886px
tall and 1063px on a phone, the form most people never use dominated it, and the two acts that cost
something were below the fold.

**Decided.**

1. **The dialog stays, wider, with tabs** — **About**, **Members**, **Integrations** — as Slack's and
   Linear's channel settings are. A new width, `size-dialog-lg` (640px), is the `Dialog`'s `wide`
   size; below the narrow width (900px) a wide dialog is a sheet that fills the screen, since a
   phone has no room for a card's margins around a whole surface. The 480px dialog is unchanged.
2. **About** holds the name and topic, the **notification level as three radios that say the current
   level in words** (the same choosing as the header's menu, `useChooseLevel`, painted first and put
   back on a refusal), and at its foot a **Danger zone** — a box in the danger tone, one row per act
   saying what it costs, each asking in place as before. **Members** has its count in the tab, Add
   people beside the heading, and a field to find a member by name once there are more than eight —
   folded as everywhere else names are matched (case, accents, the dotless ı). **Integrations** is
   the repositories (D-134), and is **absent** for anybody who is not an owner or an admin, rather
   than an empty or refused tab.
3. **Tabs are WAI-ARIA's, hand-built**: Radix Tabs is not a dependency and one surface does not earn
   one (CONTRIBUTING §1.12). One tab is in the Tab order, ← → move and choose (wrapping), Home and
   End go to the ends. Every panel stays mounted and only the chosen one is shown, so a half-typed
   name survives a look at Members. The dialog still opens on itself, never on the name (D-123).

**Rejected.** *The right-hand side panel* (where the thread, files and pins open): it is for what is
read beside the conversation, one at a time, and opening details there would close an open thread;
renaming, leaving and connecting a repository are acts done and finished, which is a dialog's job.
*Sections in one scrolling column, only wider*: the GitHub form still dominates and Leave and Archive
still sit below the fold. *Keeping the bell in the details*: it is the header's compact control; in
the details there is room to say the level.

**Cost of reversing:** one component's layout, a `Dialog` size and a token; no contract changes.
