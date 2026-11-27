# D-247. Interface polish: two gate exceptions, one native-first select — builds on D-97, D-211, D-207; closes #892

**Context.** Using the product day to day showed seams in how it feels: a ring on a button the mouse had just pressed,
a date field that was three spinning segments, a view switch that jumped and sat at a different place on each screen,
light-blue chrome in the dark themes, hard black-looking control edges in the light theme, and a list of choices that
opened as the operating system's own. Two of the fixes meet rules written to keep the interface quiet, so this records
what was bent and why, instead of bending it silently.

**Decision.**

1. **A ring follows the keyboard, not the focus.** The page records whether a pointer or a key drove it last
   (`ui/input-modality.ts`); after a pointer press, everything that is not a place to type loses its ring until the next
   key. A text field keeps its ring either way. `:focus-visible` alone was not enough: focus the page *moves* (a menu
   handing it back to its trigger) shows a ring the person never asked for.
2. **One date field of our own** (`ui/date-field.tsx`): a labelled button and a popover month, keyboard-complete
   (arrows, PageUp/PageDown, Home/End, Enter, Escape), `min`/`max` disabling days. The value is `YYYY-MM-DD` exactly as the
   native input held it, so callers changed only the element. The weeks begin on Monday.
3. **A view's mark slides** (`ui/slide-track.tsx`): the chosen segment says so in the markup and one mark moves under it
   over `duration-slide` (200 ms). The mark is measured from the segment's own box, and a track on a new screen starts where
   the last of its name stood. The views track is centred by giving both header sides the same room, so changing views
   moves nothing but the mark.
4. **Dark themes are neutral where they were blue.** The focus ring, the selected row and the selection tint are grays
   in Dark and Midnight; links, mentions and the primary fill stay blue, as does the light theme.
5. **A celebration is the one motion longer than 200 ms** (UX §9's cap is kept for everything else). Sending 🎉, in a
   message or as a reaction, sets off one of five SVG firework shows (`ui/fireworks.tsx`), about three seconds, never
   looping, never the same one twice running, not drawn under reduced motion. The token gate allows `duration-celebrate`
   alone to run to four seconds. Only what the sender sent celebrates: a feed of other people's 🎉 stays a feed.
6. **A control's edge in the light theme is a soft gray** (`border-strong`). Its contrast floor against the surfaces drops
   from 3:1 to 1.6:1, for that token alone; a control still has its fill, its label and its focus ring (which keeps 3:1)
   to say what it is. The dark themes keep their stronger edge.
7. **A select is the platform's, drawn by the page where the platform lets it** (`appearance: base-select`): in Chromium
   the list that opens is a card of rows like the menus; elsewhere it is the system's own list, still accessible and right on
   a phone.

**Consequences.** Two rules are weaker than they were, each by one named exception. A person with low vision loses some
edge contrast on light-theme fields. A browser without `base-select` shows a different list for the same select.

**Rejected.** *A hand-built listbox in place of the select* — every call site and test speaks the native element, and a
custom one gives up the phone's wheel and the platform's keyboard for a look. *A light-theme edge kept at 3:1* — it is the
black-looking line the edge was changed to stop. *Raising the whole motion cap* — it would make every transition a
candidate for being slow; one named exception for an event is the smaller change. *A date library* — the grid is forty
lines over `Intl`. *Celebrating other people's 🎉* — a busy channel would never be still.

**Cost of reversing.** Remove the fireworks, the exception and the token; restore `border-strong` and its floor; swap the
date field back for `<input type="date">`. Nothing is stored.
