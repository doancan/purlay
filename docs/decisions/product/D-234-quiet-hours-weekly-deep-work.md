# D-234. Quiet hours: Deep Work every week, by itself, on the person's own clock — builds on D-15, D-108, D-131, D-148; closes #851

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** Deep Work (D-15) is started by hand and ends
by itself within hours; nothing kept the evenings and weekends quiet without starting it every day. A person who
installs Purlay on a phone (D-230) is then woken by what arrives at 23:00.

- **A window and its days.** `from` and `to` are minutes after midnight; `from` later than `to` runs past midnight,
  and the night belongs to the day it began — Friday's evening holds through Saturday's morning; a Saturday chosen
  for nothing starts no night. One pure function, `isQuietAt` in `@purlay/types`, decides it for the server and the
  client alike.
- **On the profile's clock.** The time zone a person set on their profile (D-131) is the one fact about where their
  day is; quiet hours are read on it, and refused without one, never guessed from the server's clock. Changing the
  profile's zone moves the window with it.
- **Held back as Deep Work holds it.** `inDeepWork` answers yes for a person in either, so a notification is written
  and counted as ever and marked `suppressed_by_deep_work`: no push reaches a device (D-126). The open page goes quiet
  as Deep Work makes it — no notice, no count in the tab (D-148) — re-read at each minute's turn.
- **Per person, not per workspace.** An evening is the person's in every workspace they are in; Deep Work stays per
  workspace as D-15 made it.

**Considered and rejected.** Several windows a day (a second form for a rare need; one window and Deep Work cover
lunch and evenings). A window per workspace (an evening does not change with the workspace). Ending a window early
from the menu (turn the setting off; Deep Work already has its own end). Treating quiet hours as a non-goal's
"reminder" or "scheduling" (D-4): nothing is sent later; what arrives is held back exactly as Deep Work holds it.

**Cost of reversing.** Drop the three columns in a new migration, the card and the two routes; `inDeepWork` returns to
the membership's flag alone.
