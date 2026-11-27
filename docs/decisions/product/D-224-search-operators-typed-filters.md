# D-224. Search operators are typed filters, read on the client into the criteria search already takes — amends D-204

**Decided (the owner, 2026-10-31).** Search had controls (Where, From, Advanced filters) and nothing could be
typed; `/search` (D-214) took words only. Now `in:#api from:@alice has:code deploy` works from the keyboard.

- **The operators are the existing filters, typed.** `in:#channel` (or `in:@person` for a direct message),
  `from:@person` (or `from:me`), `has:code`, `has:file`, `is:open`, `is:resolved`, `is:question`,
  `repo:owner/name`, `on:`, `before:` and `after:` a `YYYY-MM-DD` day. Each sets the field of `SearchCriteria`
  its control sets; **no server filter and no endpoint were added**, and the server checks what it always
  checked.
- **Read on the client, into the structured request** (`features/search/operators.ts`, pure). The address,
  the request and a saved search keep criteria and the words left, never the line typed, so a saved search
  is still a filter that reapplies current visibility (D-204) and an old one still opens. Names resolve
  against what the client already holds — the channel list, the workspace's people, the signed-in person —
  folded as the `@` list folds them (#702). One reader serves the search field, `/search` and the palette.
- **What is an operator.** A known key, a colon and a value, as one token; keys ignore case, every Turkish
  i included (`İN:`). Anything else is words: `foo:bar`, a link, `10:30`. A phrase between two quotes is
  words without its quotes, so `"is:open"` is searched for as written; a quote with no partner is a
  character. The last operator of a kind wins, and what is typed wins over a control changed with it.
- **Nothing typed vanishes.** An operator that cannot be read — a channel or person nobody here is called, a
  value no filter takes, an empty value (`from:`) — stays in the words where it was typed, is searched for
  as words, and is said under the field (a polite status), from the address alone, so a reload says it too.
  It is not blocking: the search runs.
- **When it is read.** On Enter, and on any change of a control, which searches with what the field holds;
  the field then keeps the remaining words, an operator it still holds quoted so Enter again asks the same
  thing. Too few characters, more than `SEARCH_QUERY_MAX`, or an end that does not follow the start are said
  in the field (or under the composer, for `/search`) and not asked.
- **Days are the viewer's.** `on:D` is D's start to the next day's, in the viewer's time zone, sent as UTC
  instants; `before:D` ends at D's start; `after:D` starts at the next day's (as Slack reads it). A midnight
  a clock change skips begins at the first moment of that day. **This amends D-204's UI**: the date
  controls were UTC days and are now the viewer's, so a typed day and a picked one agree; the contract was
  always instants and is unchanged.
- **Discoverable** from a *Search operators* disclosure under the field — a native `<details>`, in both
  languages.

**Considered and rejected.** Parsing on the server (`q` would carry syntax, a saved search would store a
string whose meaning changes with a rename, and names would be resolved twice); dropping an operator that
cannot be read (the search would quietly widen); blocking the search on one (a typo should not stop the
rest); turning operators into chips inside the field (a second editor for what the controls already show);
UTC days for typed dates (`on:2026-10-31` in Istanbul would start at 03:00).

**Cost of reversing.** `operators.ts`, `use-operators.ts`, the help and the notice, the three callers and
the strings; the date controls back to UTC midnights. Nothing stored changes.
