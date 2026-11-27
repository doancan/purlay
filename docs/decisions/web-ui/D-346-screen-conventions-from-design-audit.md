# D-346. Screen conventions from the design audit — amends D-209, D-317, D-218

**Decided (the owner, 2026-11-26).** The design audit of every screen (D-345) changed what several screens show, and
the auditors asked for each pattern to be written down so the next screen follows it. The owner's own request among
them: the workspace switcher at the top of the sidebar sat too tight against the edge and the row below.

**What changed.**

- **The workspace's door** in the sidebar band is one 32px row: its 24px mark, its name and a chevron. Your role and
  how many people are in it head the workspace menu, as the account menu opens with who you are. In the 48px band two
  lines left about 6px above and below, and could not get more while they stayed two lines (amends D-209 and D-317).
  The sidebar options button beside it has the same height and corner.
- **A channel's header** drops its views to the narrow form (the questions glyph and count, no Feed segment, not
  centred) while a side panel or a thread is open, so the channel's name keeps its room. Its **bookmarks** scroll on
  their own while **Add a bookmark** stays in view at the end of the row (amends D-218); a chip's × takes the place of
  its link glyph rather than widening it, and a bookmark list that fails to load says so, with Retry.
- **Messages.** In a grouped message the time shown on hover in the avatar's column is the clock (`HH:mm`), not the
  relative time, which was wider than the column in Turkish; the header line keeps the relative time and the tooltip
  the full one. In the formatted composer, Enter on a line that is exactly ` ``` ` or ` ```lang ` opens a code block
  and does not send. The formatting row fades its right edge when it overflows.
- **Lists.** Followed conversations put **Unfollow** beside the row (a glyph only on a phone, named for a screen
  reader) and mark unread rows with the inbox's accent dot. A row whose actions are drawn over it takes the hover tone
  on the whole row. A reminder's time is said on the 24-hour clock (`Tomorrow at 09:00`), with the full date as its
  tooltip, everywhere it appears.
- **Panels and settings.** The incident panel's severity and status are segmented controls, not button groups, and its
  parts share one section style. A settings row with a single check box keeps it beside its label on a phone. The
  console's account rows put a pending account's check box in a leading column, order actions with the state's own
  decision first and destructive ones last, and show a disabled grant's reason on its own line.
- **Doors.** A screen outside the app that asks for something (a form, a choice) is the centred card with the mark; one
  that only says something is the notice card with its glyph and no mark. Sign-in providers' buttons are a control
  tall, not the large size.
- **Shortcuts.** The reference prints each combination as one chord (D-343); the palette's field has no Esc cap of its
  own, as its footer shows it; its empty message quotes at most 32 characters of what was typed.

**Rejected.**

- Keeping the role and member count in the band and making the band taller: every column's top shares one line
  (D-317), and the header beside it would have had to grow with it.
- A relative time narrowed to fit the avatar's column: abbreviations differ by language, and Turkish's were still too
  wide; the clock is five characters everywhere.
- A tooltip over the bookmark chip's glyph instead of the ×: removing a bookmark would have needed two steps.

**Cost of reversing.** Low to moderate: each is one screen's component and its tests; the switcher's is the largest, as
the workspace menu's first item and `UX.md` §2 would move back.
