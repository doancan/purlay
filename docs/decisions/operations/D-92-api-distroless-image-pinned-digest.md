# D-92. The API ships as a distroless image that runs the source, pinned by digest

There was no Dockerfile, so "nothing assumes this server" (D-73) was a sentence about a deployment
that could not yet be made (#248). The shape of the image decides what an attacker who reaches the
process finds, and what an operator must trust.

**Decided.** Two stages. The first (`oven/bun`, slim) installs production dependencies from the
frozen lockfile and nothing else. The second (`oven/bun`, **distroless**) receives `node_modules` and
the sources of the API and the two packages it uses, and runs as the numeric user `65532`. There is
no shell, no package manager and no `curl` in it; the container's `HEALTHCHECK` is the Bun runtime
asking `/health/ready`, so a process that is up but not ready — database away, migration pending,
draining (D-72) — is reported unhealthy. Both bases are pinned by digest with the tag beside it, and
Dependabot's docker ecosystem proposed the next digest (D-219 ended that; the owner moves it), for the reason pins are CI-checked (D-91).
It starts with `--read-only --cap-drop ALL --security-opt no-new-privileges`, which
`scripts/image-smoke.sh` does on every pull request that touches it.

**Nothing is compiled.** Bun runs the TypeScript the repository contains, which is also what the
tests run, so there is no second artefact that could differ from the one that was tested. A
pull request builds the image and runs it against the compose PostgreSQL, pushing nothing; a push to
main publishes it to GHCR tagged by commit and by branch (never `latest`: an operator pins a commit
or a release), with provenance and an SBOM attached as attestations. The publish job can be exercised
for real only once it is on main.

*(Amended 2026-10-11: while Actions cannot run, `scripts/release-image.sh` publishes a merged commit
from a machine — a commit on `origin/main`, from a clean tree, after `verify` with the database, built
once for the server's platform, smoke-tested, then pushed as `sha-<commit>` and named by digest. It is
not the workflow's equal and says so: the image carries no provenance or SBOM, it is smoke-tested
before the push rather than as the pushed digest, and no `main` tag moves. It is for the gap and
nothing else; when the pipeline runs, it publishes. Rejected: waiting for the pipeline, which would
leave S-1 with nothing to dogfood; building on the server, which puts a toolchain on it and runs an
image no digest names.)*

**What stays with #224.** This is the API. Serving the built client from the same origin waits for
the prerendered shell (#141), and the image grows a stage for it then; the production compose
assumes only that one origin fronts the API. *(Amended 2026-10-11: #224 added the middle stage, which
builds the client; only `apps/web/dist` reaches the runtime stage, which sets `CLIENT_DIST` (D-61,
D-102).)*

**Rejected: an Alpine or Debian base.** A shell, a package manager and musl or glibc differences for
no benefit to a program that needs only its runtime. **Rejected: `bun build --compile` into one
binary.** It would be a second artefact the tests never ran, and the migrations are files read from
disk. **Rejected: an init process (`tini`).** The process handles SIGTERM itself and drains
(`lifecycle.ts`); an init adds a binary to a shell-less image to do what the code already does.
**Rejected: a floating tag, even `1`.** The digest is the claim the documents make.

**Reversibility:** free. Nothing is stored in the image; the volumes are the database and the bucket.


*Amended 2026-10-09:* the smoke test ran the API container against the development compose database through
`host.docker.internal`. When that database's port was bound to the loopback address (the superuser's password
is in the repository, so it should be), a container on a Linux runner could no longer reach it, the log said
`migrating on start failed`, and the `image` check was red on main for three commits, because it was not a
required check. The smoke test now creates a throwaway network and a throwaway PostgreSQL of its own (the
image named in `docker-compose.yml`, nothing published), runs the API on the same network by container name,
and removes both when it ends; `scripts/image-smoke.test.ts` fails if it references the host again. It no
longer depends on what any other file publishes.

*Amended 2026-10-09 (a second-round audit that opened the image):* it shipped every `*.test.ts` — 75 test
files, 83 with the directory of test-only code beside them — because the Dockerfile copies the source
directories whole. `.dockerignore` now leaves out `**/*.test.ts` and `apps/api/src/testing`, and the smoke
test asks the **image** (not the ignore file) how many are in it and fails on any: 83 on the image as it
was, 0 now, the rest of the smoke test unchanged. Lint already refuses production code importing the
test-only directory, so nothing the process loads is among them. The image is 1 MB smaller; the point was
never size. Separately, the probes `/health` and `/health/ready` were most of the log (a balancer and the
container's own check poll them every few seconds): they are written at `debug`, and a probe that fails is
still visible because readiness writes its reason at `warn`.

*Amended 2026-10-09 (a second-round audit):* the `image` workflow had a path filter, so a pull request that
broke the Dockerfile ran no check at all, and a check that does not run cannot be required. It now runs on
every pull request and decides inside the job (`scripts/pr-touches.sh`) whether there is anything to build;
when there is not, its steps are skipped and it reports success. And the publish job **built a second time**
instead of promoting what had been tested: on main the image is now built once, pushed **by digest** (untagged,
with provenance and an SBOM), the same smoke test is run against that exact digest, and only then is it given
its tags (`sha-<commit>` and `main`) by `imagetools create` — a retag, not a rebuild. Exercised locally against a
registry: the digest the build reported is the digest `:main` resolves to, the attestation manifest is
there, and the smoke test passed on the pulled digest. The check names to require: `build` (pull requests).
