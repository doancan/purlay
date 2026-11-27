# D-320. Search says how many it found, and a tab counts only what is waiting — builds on D-166, D-315, D-316

**Decided by the owner, 2026-11-19**, from a live review of v0.7.1 (#1478). *Search.* The results were a list with no answer above it: an empty and a loaded list began the same way, and a screen reader heard a list appear and nothing that said what it was. The screen now says *2 results* (or *20 results so far* when **Load more** has more) in a status line above the list, and the Search button is the form's one primary button, as the button's own rule says. *Tabs.* Reminders and Scheduled carry a count and Drafts, Sent and Saved's states do not; this was an accident of two features and is now the rule: a count marks a list of things waiting for a moment, which is what a person wants to see change, and not a record, where a count only goes up.

**Rejected.** A count on every tab: it turns Drafts and Sent into numbers to keep at zero. A total count from the server for search: the search is paged by cursor and a count would make the server count every match for every query; "so far" is honest and free.

**Cost of reversing.** The two message keys and the status line; the rule is prose.
