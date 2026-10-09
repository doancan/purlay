# Spike — the local object store

**2026-10-09.** `docker-compose.yml` pinned `minio/minio` and `minio/mc` by release tag, and neither
can be pulled any more (#183). Attachments (D-16) are the first code to read object storage, so the
replacement was chosen against what attachments do, not against a feature list.

## What was run

Each candidate was started in Docker on Apple silicon (aarch64 Linux), given a private bucket named
`purlay-attachments`, and driven through **Bun's built-in `S3Client`** — the same client the upload
path would use, so the S3 dialect it speaks is the one that matters. Sixteen operations, one script
(`probe`): write, read, `exists` for a present and a missing key, `stat`, a 3 MiB binary round trip
compared byte for byte, a ranged read, a streamed read (the brokered download), list by prefix, a
presigned URL and a request made with it, an **anonymous read**, delete, and delete of a key that
never existed. Then a 25 MiB object — the attachment cap, `SCHEMA.md` §7.2 — written both through the
multipart writer and through a single `write`.

| | Image | At rest | Licence | Result |
|---|---|---|---|---|
| **Garage** 2.1.0 | 11 MB | 7 MB RAM | AGPL-3.0 | **16/16, and 25 MiB both ways** |
| **RustFS** 1.0.1 | 106 MB | 120 MB RAM | Apache-2.0 | **16/16, and 25 MiB both ways** |
| **SeaweedFS** (`latest`) | 184 MB | 88 MB RAM | Apache-2.0 | `SignatureDoesNotMatch` on every signed request |
| MinIO, both registries | — | — | — | no manifest: the image cannot be pulled |

An unsigned request was refused with `403` by all three that started. A wrong secret was refused by
RustFS with `SignatureDoesNotMatch`; that control was run for RustFS only.

## Verdict

**Garage.** The reasons are in D-20's amendment; the ones the measurements support are size, and that
nothing was loosened to make it work. RustFS is the written alternative.

## What it costs to run

- **The image has no shell** — `docker run --entrypoint sh` fails — so compose cannot create the bucket
  the way a sidecar could. `scripts/storage-init.sh` does it from the host through `docker compose
  exec`: assign the node to the layout, create the bucket, import a development key with a fixed
  value, grant it. It is idempotent; run twice, the second run changes nothing.
- **A fresh node has no role.** Until the layout is applied, `/garage status` is healthy and the S3
  API refuses to store anything. The compose healthcheck therefore means *the process is up*, and the
  script is what makes it *ready* — which is why `db:up` runs it as its last step.
- **Keys have a format.** `GK` and 24 hex digits, a 64-hex secret. A development key chosen for
  readability is rejected.
- **No console.** MinIO's was a convenience nothing depended on.

## What had to be loosened

**Nothing in the repository's rules.** No lint rule, compiler flag or budget changed. What *did* change
shape: the compose file lost a one-shot sidecar and the repository gained a shell script, because the
image offers no other place to put the setup.

## What surprised us

- **My own control failed to fail.** The bootstrap script was first written to "prove the bucket is
  private". Enabling Garage's website mode on the bucket did not change its answer — website mode is a
  separate port the S3 endpoint does not share — so the check could not have detected the thing it
  claimed to. There is no public-read setting on Garage's S3 endpoint at all. The script now says what
  it actually checks (the published port refuses an anonymous read, and fails on `000` when the wrong
  thing is listening, which was demonstrated) and nothing more.
- **`exists()` with a wrong secret threw `UnknownError`**, not an authentication error. The upload path
  should not map a failed existence check to "not found".
- **SeaweedFS's failure is not a verdict.** The configuration was written once from its documented JSON
  shape and rejected every signature; whether that is the configuration or the software was not
  established, and the entry says so.

## Not run

- x86-64. Garage publishes multi-architecture images; only aarch64 was run.
- Behaviour after a Garage upgrade across a metadata format change — relevant to a self-hoster's
  upgrade runbook (Phase 2), not to this choice.
- Concurrent 25 MiB uploads. A measurement for #53, with the budget it sets.
- RustFS and SeaweedFS persistence across a restart: checked for RustFS only (an object written before
  `docker restart` was read after).
