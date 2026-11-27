# D-32. Work is tracked in GitHub Issues and Projects

**Decided: GitHub Issues for the unit of work, a GitHub Project board for the view.** One issue
per task; the milestone is the version it ships in, and carries that version's exit criterion.

**`ROADMAP.md` is retired (the file is deleted).** It held the same task list the issues now hold, and keeping
both would have been the duplication `OVERVIEW.md`'s ownership rule exists to prevent — the copy
that drifts is always the one nobody is looking at. Its two unique facts moved: the *working
rule* (a task is done when typed, tested and documented; a milestone is done when its exit
criterion is demonstrated) went to `CONTRIBUTING.md` §7, and the "not on this roadmap, ever"
list was already only a pointer to `PRD.md` §6.

**Rejected — Linear:** better interface, and the wrong home for this project. It is a per-seat
closed SaaS, which is the model D-1 exists to reject; it puts the work behind a second account
for anyone who wants to contribute; and S-2 wants a stranger to find the plan next to the code,
not in a tool they have no login for.

**Rejected — OneDev, and this was the closer call.** A self-hosted platform that carries git,
issues, review, CI, a registry and boards on one lightweight process is philosophically *more*
consistent with a self-hosted product than GitHub is, and that inconsistency is real rather than
imagined. It loses on four concrete grounds, none of them ideological:

1. **GitHub is an integration dependency here, not a convenience.** PR and Issue unfurl is the
   Phase 1 wedge (D-23), Phase 2 adds webhook repo feeds, and D-11 makes GitHub OAuth the only
   identity path. With the repository elsewhere, the project cannot paste its own pull request
   into its own chat and see the card — it cannot dogfood the one axis D-2 says is judged
   qualitatively by the dogfood team.
2. **S-2 is a distribution criterion.** Strangers do not discover self-hosted instances. Leaving
   GitHub does not slow that goal down, it removes its channel.
3. **S-4 is an access criterion.** A reviewer needs a URL that opens without an account.
4. **`CONTRIBUTING.md` §1.11 applies to us too.** Operating a DevOps platform — backups,
   upgrades, TLS — to track a few dozen issues for a team of one is the complexity this project
   refuses everywhere else.

**What would reverse this:** OneDev wins if Purlay stops being GitHub-native (D-23 and the Phase 2
feeds leave scope) **and** the repository stays private permanently (S-2 and S-4 are abandoned).
Both together describe a different product, so that is a `PRD.md` change and not a tooling choice.

**Rejected — issues in a Markdown file:** it is what the roadmap already is, and it cannot show
what is in flight.

`CONTRIBUTING.md` §8 is unchanged and still binding: **no issue or ticket reference appears in a commit
message.** Linkage lives in the pull request body, where it belongs.
