# D-263. A release moves the last number unless somebody asks for more — builds on D-185

**Context.** D-185 left the kind of each release to whoever runs `bun run release`, and it refused to run without
one. Three releases in, each was a minor (`0.1.0`, `0.2.0`, `0.3.0`): the middle number climbed with every
release. The owner wants it the other way round while Purlay is `0.x.y`: releases move `y`, and `x` moves only
when somebody decides a release is worth it.

**Decision.** `bun run release` with no kind is a **patch** (`0.3.0` → `0.3.1`). `minor`, `major` or an exact
`x.y.z` still work, and are asked for by name — by the owner, or by whoever prepares the release on their word.
`--dry-run` may come before or after the kind. Anything else it does not know is a usage error, as before.

**Rejected.** *Keeping the kind required*: the default is what is typed, and what was typed was `minor`.
*Choosing the kind from the changelog* (a minor when there is an *Added*): every release so far had one, which is
the habit this changes.

**Cost of reversing.** One default in `release-prepare.ts` and its tests.
