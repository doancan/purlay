# D-328. Each source of the find is cut at the limit and says whether it had more, and an answer missing a slow or failed source says it is partial — builds on D-285; amends D-285 §3

**Context.** D-285 §3 answered up to ten hits for each source and a list of the sources skipped. A source with thousands of matches cost the answer only its limit already (it is asked for `limit`, and what it returns beyond is cut), but the answer could not say that there was more; and an answer missing a slow source looked complete unless the client read `skipped` and knew which reasons mean "ask again".

**Decision.**

1. **Each source is asked for one more than the limit**, cut to the limit, and its group carries `more`: true when it had that one more. A client can say "10+" and send the person to the source's own screen, which pages (D-285 §3 still holds: no cursor across sources). The cap is the core's, whatever a source answers.
2. **`partial`** on the answer is true when a source the workspace could have been answered by was `slow` or `error`: the groups are what finished in time. `off` does not make an answer partial, since asking again would find nothing more.
3. **No total count.** A count per source would be one more scan of every match for every source under the same deadline; `more` is free (D-320 made the same choice for search's "so far").
4. Both fields are added to the response, and a client that does not read them is unchanged: `CONTRACT_VERSION` does not move (D-58).

**Rejected.** *A count of every match*: see 3. *Hits a slow source had found before its deadline*: a source answers once, with all its hits or none; a source that streams is a different port and no source needs it. *Calling an answer with an `off` source partial*: a client would offer to try again for a module the server does not run.

**Cost of reversing.** Two fields of `@purlay/types` (`FindGroup.more`, `FindResponse.partial`), which a reversal would have to keep emitting for clients that read them; the `limit + 1` in `modules/find/find.ts`.
