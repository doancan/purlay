# D-175. The layout takes the width a desktop window has

**Context.** The columns were sized for a laptop: the feed at most 760px, Settings 720px, the thread
panel 380px, the sidebar 240px, dialogs 480px and 640px. On a 1440px window the feed left about 190px
empty on each side, and on a 1920px one about 450px; Settings sat in a column of 640px usable width.
The owner, judging it live, found the product too narrow. The widths are tokens
(`packages/tokens/tokens.json`), so the change is the tokens and nothing beside them.

**Decided.**

1. `size-feed-max` 760px → 1040px: the feed, the composer under it and the list screens that share
   its column (D-158). A bubble is still at most five sixths of the feed (D-119; *no bubble since D-187*), so a line stays
   readable while a code block, a diff and a card get the room they lacked.
2. `size-settings` 720px → 960px, and `size-field` 320px → 360px, so a settings row's label and its
   control both breathe and a description is not wrapped into a column.
3. `size-thread` 380px → 440px: a reply's code and the panel's composer toolbar (D-164) fit without
   the key hints being the only thing dropped.
4. `size-sidebar` 240px → 264px: longer channel names and a group's faces (D-167) are cut later.
5. `size-dialog` 480px → 520px and `size-dialog-lg` 640px → 760px, in step with the rest.

Below `size-narrow` nothing changes: every column is the window's width there already.

**Amends** D-110 (the sidebar and the feed's width), D-119 §7, D-122 §3 (the panel's width), D-146 (the
Settings column) and D-154 (`size-dialog-lg`). Those entries keep the numbers they were decided with;
this one is where the widths are now.

**Rejected: a fluid feed with no maximum.** On an ultrawide window a line of a few hundred characters
is not read; the cap is moved, not removed. **Rejected: a density setting** (compact / comfortable) —
one layout the product is judged in until somebody needs the other.
