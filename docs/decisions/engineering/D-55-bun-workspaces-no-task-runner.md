# D-55. Bun workspaces are the build orchestration; there is no task runner

The stack table listed **Bun workspaces + Turborepo** and accepted "Turborepo config is another
thing to maintain" as its cost. Nothing was ever installed: there is no `turbo.json` and no `turbo`
in any manifest. The table described a repository that does not exist, which is worse than either
choice — a reader following it looks for a file that is not there, and a claim nobody checks is a
claim that stays wrong.

Resolved by deciding rather than by installing. **Bun workspaces are the orchestration.** Five
packages, one `tsc --build` that already caches incrementally through project references, and a
pipeline whose longest job is under a few minutes: a task graph and a remote cache have no defect
class to justify them here. It is the argument D-47 makes against DDD ceremony, one layer down.

**The trigger, named rather than implied.** Add one when the pipeline repeats work it has already
done — concretely, when `verify` exceeds five minutes locally or a CI job exceeds ten, and the
cause is rebuilding unchanged packages rather than the work itself growing. Until then the
orchestration is a shell `&&`.

**Rejected: installing it now to make the document true.** Configuration written before there is
anything to cache is configuration nobody can evaluate, and it would have to be maintained through
every packaging change in the meantime for a benefit measured at zero.
