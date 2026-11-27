# D-167. Browse says what a channel is before it is joined; a group has a face

**Context.** Browse channels listed a name and, sometimes, a topic: nothing said whether a channel
was where the team talks or an abandoned experiment of one, and the only way to find out was to join
it. Slack and Linear both say how many people are in a channel before you join. In the sidebar, a
group conversation drew the first of its people's avatars, so a group of three looked like a direct
message with one of them. The owner asked for both (2026-10-19); how they are built was decided under
their standing instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **A channel carries `memberCount`**, for every channel the caller sees, joined or not: its live
   members, an erased account not among them — the number its members list holds, so the dialog and
   the details never disagree. It is read in the channel list's own statement, as one aggregate
   grouped by channel over the same ids the list is narrowed to (`readChannels`), joined in, never a
   count a channel; the list's statement count stays the same however many channels there are
   (the existing N+1 test). `EXPLAIN ANALYZE` over 2,000 channels and 100,000 memberships, sixty
   channels listed: one `HashAggregate` fed by a bitmap scan of `channel_members (channel_id,
   user_id)` with `channel_id = ANY(…)` as its index condition, 2.1 ms. The count is as of that read: another person's join is not pushed to
   everyone who might browse. A count a person reads in a dialog they opened is allowed to be a
   minute old; a frame to every member of a workspace for every join is not worth that minute.
2. **Each row of Browse** is the name, then one quiet line: *12 members*, and the topic after a dot,
   cut with an ellipsis before the count is. By name (D-160), as before.
3. **A field to find a channel appears past eight**, the threshold the channel details' members list
   already uses — now one constant, `FINDABLE_FROM` in `ui/text-field.tsx` — matching the name and the
   topic without case or marks (`fold`), and saying so when nothing matches. Closing the dialog forgets
   the search.
4. **A group's face is its first two people, the second overlapping the first, and "+N" for the
   rest**, in the order of its key — the order its name is written in, so the faces and the name
   agree. Each piece is one small avatar (`size-avatar-sm`) overlapping the last by 4px and showing
   one letter — two letters at 20px were half covered by the next face, seen live — so the row keeps
   its height; a group is
   at most ten people (D-127), so N is at most seven and is always one digit on a chip of the same
   size. An overlapping piece is cut out of the one behind it by a hairline in the colour of what it
   is drawn on — the sidebar's, following the row's hover; the accent on the row you are in; the
   page's in the header; the selected option's in the palette — so two people with the same tint are
   still two. The same face stands in the sidebar row, the palette's group row and the group's header,
   where a generic glyph stood. An erased person is *Deleted user* in the reader's language, in the
   face and in the name.

**Rejected.**

- *The count only for channels the caller has not joined.* A field that is sometimes absent is a
  second shape for every reader of the list; the aggregate costs the same either way.
- *Pushing counts on every join and leave.* See §1: a frame per membership change to every member of
  the workspace, for a number read in one dialog.
- *A count in the members list's endpoint, read when a row is shown.* A request per row is the N+1
  (D-13).
- *Slack's stacked square (two smaller avatars diagonally inside one)*: it needs an avatar smaller
  than `size-avatar-sm`, a new size token for one place, and the initials stop being legible.
- *A number in place of the faces* ("3"): it says how many but not who, which is what a face is for.

**Cost of reversing:** the column in `readChannels`, the field in `Channel` and its fixtures,
`features/conversations/group-face.tsx` and its three uses, the dialog's row and field, the strings
and their tests.
