# D-195. A person arranges their own sidebar, by what is shown — builds on D-110, D-118 §6, D-132, D-160

*Amended by D-284: A person groups their own channels under named headings across devices — #1198.*

**Context.** The sidebar listed everything the person had joined, always, in one fixed order, and the workspace's name
at its head was a button that ran from the rail to the hairline, so its hover and its focus ring touched both. Slack,
Linear and Notion all let a person fold what they do not need and leave out what they do not want: Slack folds a section
but keeps what is unread and the open conversation under its name, filters to unread and sorts by name or recency; Linear
hides what is not used and offers a menu for the arrangement; Notion folds a section by its heading. For a team of
a few dozen channels the difference is a column that is read and one that is scrolled.

**Decision.**
1. **The head of the column** is the workspace's tile, its name and the switcher chevron, inset and rounded as every row
   under it is, so nothing in the column touches the rail or the hairline; **Sidebar options** is beside it, and the jump
   field lines up with the rows.
2. **A heading folds its section.** It is a button (`aria-expanded`, its name still the section's), with a chevron after
   the name that is drawn on hover and focus, always once folded, and always on a touch window. A folded section keeps
   under it **what is unread, what mentions the person, a channel with an incident open and the open row** — a fold never hides what is waiting or what is on fire.
3. **Sidebar options** is one menu: *Show* — everything, or only what is unread (the same keep-rule, plus the open row);
   *Sort channels* — by name, which keeps a place where it was (D-160, and still the default), or by what was written
   in them last; *Sections* — Conversations and People may be switched off, **Channels may not**, and what the person
   starred stays (D-132); a section that is off is still drawn for the one conversation the person is in, under its
   heading, until they go elsewhere — a row is never taken from under them; *Hide muted channels* — a muted **channel** goes unless it mentions the person, has an incident open or is
   the open one, and a starred one stays whatever it is; conversations and people are not channels and are never left
   out for being muted (a muted person is still the only way to that conversation); **Reset sidebar**, offered only while something is changed. The button is
   drawn filled and its name says *changed* while anything is: a sidebar that shows less than the workspace has must
   not look like one that shows all.
4. **Kept in the browser, per person and per workspace** (`purlay.sidebar.<user>.<workspace>`), read once and written on
   change; a page whose storage refuses arranges the sidebar for as long as it is open and leaves the note D-126's other
   keys leave (`data-storage-failed`). It holds no words and no channel, so a sign-out does not forget it, and the person's
   id is in the key so the next person on the machine finds their own.
**Rejected.**
- *A compact row height.* D-118 §6 puts density in what is shown, not in compression; this decision is that, in menu form.
- *Dragging sections or channels into an order of one's own.* A saved order is the saved layout D-110 declined: another
  state to keep right as channels come and go, and the one place that would move a row under a pointer. If it is wanted it
  is its own decision, with the server keeping it.
- *A resizable sidebar.* `UX.md` §2 keeps no resizable panes; unchanged.
- *Custom sections, and a sort or filter per section.* Slack's own paid tier; for the size of team this is built for, one
  menu for the whole column is enough, and the second knob is where a menu becomes a settings page.
- *Keeping it on the server.* It would follow the person to every device and give the macOS client the same arrangement;
  it needs a table, an endpoint and a conflict rule, for a thing that is changed in passing. Not now.
- *A switch to turn Channels off.* A sidebar with no way into a channel, whose only way back is a menu inside it.

**Accepted.** A section switched off hides what is waiting in it too: a direct message from somebody is reachable
from the inbox on the rail, which is where what needs the person is gathered (D-106), and is listed again the moment
the section is back. The arrangement is per device: two browsers of one person differ until each is set. A fold of a section
with nothing waiting shows a heading and nothing else, which is the point.

**Reverses if** a per-person preference store is built on the server (the web and the macOS client would read one
arrangement): the keys here are then migrated into it and this one's storage is dropped.
