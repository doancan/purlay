# D-17. Performance budgets that can actually be measured

The earlier drafts asserted `<35MB idle memory` and `sub-millisecond` search. Neither was
achievable, and neither was measurable as written. A requirement that fails on first
measurement teaches the team to ignore the documents — which is worse than having no
requirement at all.

**Decided:** every performance claim is replaced by a falsifiable budget with a number, a
percentile where one applies, and a stated measurement condition. Anything that cannot be
enforced in CI does not belong in a document.

> **Single source of truth:** the budget table lives in `PRD.md` §5.
