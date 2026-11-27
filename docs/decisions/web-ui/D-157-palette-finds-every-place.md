# D-157. The palette finds every place, and a query never ends in nothing

**Context.** `PRD.md` §4.6 promises a palette over channels, DMs, people and settings, and UX §1.3 calls
it the primary navigation. The messaging audit (2026-10-19) found it a channel switcher: "inbox",
"saved", "search", a public channel not joined, a group conversation — none were found, and a query
that matched nothing ended in "No match".

**Decided.** The palette lists the rail's places (Open questions, Inbox, Saved, Search) as views;
public channels the person has not joined, with *Not joined* beside them (opening one shows its Join
bar); group conversations by their people (D-127), found by any member's handle; every settings page
the person may open (D-146). Whatever was typed is also offered as **Search messages for “…”**, in a
group of its own that is always last, so arrows and Enter reach it in the order it is drawn; with no
other match the palette still says "No match" above it.

**Rejected.** *Actions that open dialogs (New channel, Invite)* — their dialogs are owned by the
components that draw their doors; a second door would need the state lifted for one shortcut.
*Keyboard shortcuts as an action* — the Settings page of that name is already listed; two rows with
one name is a guess for the person.

**Cost of reversing:** the items in `use-palette-items.ts` and the search row in `command-palette.tsx`.
