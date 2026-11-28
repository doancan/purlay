# D-261. A release's notes lead with what it is about, list the rest plainly, and are greeted — builds on D-185, D-247, D-248, D-259

*Amended by D-361: a release is greeted by confetti, not fireworks.*

**Context.** D-248's window listed six Keep a Changelog categories as plain headings with plain bullets: a release
that added one big thing and forty small ones read as forty-one equal lines, a person could not tell a security fix
from a layout tweak without reading both, and a new version opened as quietly as an old one. The owner asked for
the big features to come first, for the categories to be told apart, and for a celebration — and, once it was drawn,
for the tags not to look like buttons, for the big things on a light blue ground, for the rest in a proper list, for
the fireworks to be one smooth four-to-five-second show, and for the scrollbar to show only under the pointer.

**Decision.**
1. **`Featured` is a category**, first in the grammar, only when a release has something big, and **at most three
   bullets** (`FEATURED_MAX`, judged by `problemsIn`): a release that features everything features nothing. The
   other six are as they were, so v0.1.0–v0.3.0 read unchanged; the files and the GitHub Release stay Keep a
   Changelog markdown, and Featured simply appears first in both.
2. **The parser types a bullet**: `ReleaseNotesItem { markdown, area, body }`, where the area is the bold word a
   bullet starts with (`**Messages** — …`). A bullet with no area is its words alone.
3. **The window**: Featured is a light blue block (`bg-accent-subtle`) of titles and sentences, above everything.
   Every other category is a plain list under a quiet heading — a dot, a word, a count — with the area in a column of
   its own and a hairline between lines. **No pills**: a pill is the shape of a button, and only buttons are buttons;
   the dots are the status tokens' colours and the word is always beside them. Display names are i18n (*New*,
   *Improved*, *Fixed*, …); the file headings are not translated, so nothing about the files changes. A link at the foot
   opens the release on GitHub.
4. **One grand show, not a chain.** `celebrate('grand')` runs one show: two different shows' bursts, the second a fifth
   of the way in, and — on a screen at least 1.3 wider than tall, where the field is widened — four more out on either
   side. The 🎉 is `celebrate()`, a small show as before. **Its length is the token's, every time**: the new token
   `duration-celebrate-grand` (4.5 s) is the whole run, and the run's pace is that over what its bursts add up to (the
   last to open plus the time its sparks sink), so two shows with different last bursts still last the same smooth four
   and a half seconds, and the layer then removes itself. The token audit's celebration allowance is the family
   `duration-celebrate…`; its cap rises from four seconds to five so that a whole release show fits, and no
   other motion is touched. A new version opens it by itself, opening the notes by hand shows it too, reduced motion
   draws none.
5. **A scrollbar that waits** (`scrollbar-hover`): drawn only while the pointer is over what scrolls or a keyboard
   has focus in it; its track keeps the room, so nothing shifts when it appears.
6. **Verified end to end** by tests at each joint: the grammar (`changelog.test.ts`), the client's parser over every
   published file (`releases.test.ts`), the release command's roll (`release.test.ts`), the published GitHub Release
   body for every category in order (`release-publish.test.ts`), the window and the show over the bundled notes
   (`release-notes-once.test.tsx`, `fireworks.test.tsx`, `about.e2e.ts` — with motion allowed and with it reduced).

**Rejected.** *Tag pills* (they looked like buttons, and the owner said so). *A row of counts or a proportion bar at
the top*: more furniture before the first word. *Renaming the file headings to Features/Fixes*: every published file
and the Keep a Changelog contract would change for a label. *Three shows one after another*: nine seconds is a wait,
not a flourish. *Fireworks on every open*: only a release (or a deliberate open) is a moment; a 🎉 stays small.
*A Featured with no limit*: it turns into the list it was meant to sit above.

**Cost of reversing.** One category in the grammar and the parser, the dialog, a token and its allowance, a CSS
utility and an argument to `celebrate`; the notes files do not change.
