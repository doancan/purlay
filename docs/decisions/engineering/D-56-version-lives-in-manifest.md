# D-56. A version is a fact, so it lives in the manifest and nowhere else

`ARCHITECTURE.md` §2 named versions alongside choices: *Bun 1.4+*, *PostgreSQL 18*, *React 19*. Two
of the three were bound to reality by a test. The third was not, and could not be — nothing had
installed React, so there was nothing to bind it to. The table was asserting a fact about a
repository it had never looked at.

That is the general shape, not an accident of one row. A version in a document is a **copy**, and
the copy is the one that goes stale silently: this project already carried *PostgreSQL 16* for
months after deciding to move, and D-55 found *Turborepo* named in the same table with nothing
installed at all.

**So §2 names choices and never numbers.** `check-docs.py` already refused a version outside its
owners; `ARCHITECTURE.md` has simply stopped being one. `DECISIONS.md` keeps the exemption because
it records dated history — *"the documents said PostgreSQL 16"* has to remain sayable — and the
changelog by definition.

**And every dependency is pinned exactly.** The repository was mixed: `eslint` exact,
`kysely` caret, with no rule written down for which was which. A caret range is the polite form of
*I do not know which version this is*; the lockfile knows, but a lockfile is a consequence, and a
pass from a differently-resolved tree is "green in one state is not green" one layer down. An exact
pin turns an upgrade into a commit CI judges — which is what the weekly grouped Dependabot pull
requests were (D-219 ended them; the owner's update commits are judged the same way). `workspace:*` is exempt: it is not a range, it names a package in this
repository and cannot resolve to anything else.

**Rejected: generating the table from the manifests.** It would be accurate, and it would still be
a second thing to read that adds nothing — the manifest is already legible, and a generated copy
is a copy whose generator has to be maintained. **Rejected: a rule for which dependencies are
pinned and which are ranged.** Two policies separated by a line nobody remembers is how the
repository got into this state.
