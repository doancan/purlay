# D-59. The stack table says what is installed, and a test agrees

D-57 required a spike before a tool enters the table. That stops a *future* guess; it does nothing
about the ones already there. Turborepo sat in §2 for months with nothing installed, and a web
framework version sat beside it while nothing had installed the framework. Neither was catchable,
because the table recorded what the project had **chosen** and nothing compared that to what it
**had**.

**A third column, and it is checked.** A cell names the packages or compose services that make the
row real, and every one is resolved against the manifests and `docker-compose.yml`.

The important half is the other direction. **`not yet` names its packages too, and they must be
absent.** Without that, a row can quietly stay behind after its thing is installed — the same
drift, pointing the other way, and the one nobody would think to look for. `undecided` means no
package has been chosen at all and must cite the issue or open question that will choose it, so a
category cannot sit in the table wearing a decision's clothes.

**It found one immediately.** *"A small CommonMark/GFM renderer"* and *"a sanitising serialiser"*
had no packages to name and nothing watching for the choice. They are **O-6** now.

**Rejected: generating the column.** It would be accurate and it would prove nothing — a generated
column agrees with the manifests by construction, which is exactly the question being asked. The
column has to be **written** and then contradicted by a check, or it is not evidence.

**Rejected: requiring an issue for every `not yet` row.** Most are Phase 1 features whose issue does
not exist yet, and forcing one would create board noise to satisfy a check. The feature that needs
the package installs it; the check only insists the row moves at the same time.
