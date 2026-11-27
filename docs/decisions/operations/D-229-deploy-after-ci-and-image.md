# D-229. A commit deploys only after its own `ci` and `image` runs have both succeeded — amends D-185; closes #798

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** `deploy` started on a successful `image`
run alone, and `image` does not wait for `ci`. On 2026-10-28 commit `8283c4a6` was live at 09:12 while its `ci`
failed at 09:19: the server ran a commit the gate later refused. Merging is not the proof either; branch protection
judges the pull request's head, and a rebased merge is a new commit that the push's own `ci` run judges.

**Amended 2026-11-09.** The same gate now protects release publication, independently of any
production runner; Dockhand applies release images (D-262).

- **`deploy` listens to both workflows.** The hosted `gate` asks for the exact commit's newest push
  run on `main` of `ci.yml` and `image.yml`. Both completed and successful permit publication. A run
  still in progress waits for its completion event; failed, cancelled or missing runs refuse it.
- **The gate validates main ancestry before checkout.** Only `behind` or `identical` compared with
  `main` is accepted. Workflow runs must come from this repository's main push; manual runs must
  use main's workflow. Only the gate has `actions: read`.
- **A manual retry has the same gate and cannot wait.** A commit inside a rebased merge has no push
  runs of its own and is refused. The release job needs the gate's explicit `ready=true`, checks out
  its exact commit, and runs entirely on a hosted runner. It does not switch a production container.

**Considered and rejected.** Making `image` depend on `ci` delays image publication and its own PR
check. Listening to `ci` alone can race the image build. Polling inside a job ties up a runner while
completion events already provide the retry. Following `:main` directly bypasses the full CI gate.

**Cost of the choice.** Near-simultaneous completions can retry publication, serialized by
`concurrency: deploy`; an already published version changes nothing. The release image path requires
Dockhand polling to be configured, and CI success is not a deployment receipt. **Cost of reversing.**
Restore a separate server deployment job, without weakening the exact-commit gate.
