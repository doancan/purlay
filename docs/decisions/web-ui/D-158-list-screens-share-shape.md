# D-158. The list screens share one shape

**Context.** The inbox, the open questions, search and saved each drew their list their own way — hung
from the left at the feed's width with half the window empty, rows as floating rounded hovers, saved
items with two or three buttons under every row. After the inbox became cards (D-153), the other three
read as a different product.

**Decided.** One shape, in `ui/list-column.tsx`: a centred column at the feed's width (D-119) on the
ground a step below its cards; each list a card of rows divided by hairlines, with its heading (a day, a
channel) above it; a row is one button, padded alike. A row's own actions (Mark read, a saved item's
moves) sit beside its button, appearing over the row's meta line in its hover tone on a pointer's hover
or a keyboard's focus, and stay below the words on a phone. Search's field and *where* sit in a card of
their own above the results.

**Rejected.** *Leaving each screen its own layout* — four answers to one question is the drift a shared
primitive exists to stop. *Always-visible row buttons on a wide window* — three buttons under every
saved item made the list a toolbar.

**Cost of reversing:** the primitive and its four uses.
