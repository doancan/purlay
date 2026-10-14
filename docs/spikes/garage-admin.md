# Spike — preparing Garage on `up`, through its admin API

**2026-10-14.** #76 asks that a stranger bring the production stack up with one command. The one
step left after `docker compose up` was `scripts/production-init.sh`: the node's place in the
layout, the bucket and the application's key, made through Garage's CLI with `docker compose exec`.
Compose cannot run that itself — the Garage image carries no shell (`object-storage.md`), and one
service cannot exec into another. Garage's admin API can be driven over HTTP from the API's own
image instead.

## What was run

`dxflrs/garage:v2.1.0` (the digest the compose file pins), one node, the production configuration
plus `[admin] api_bind_addr = "0.0.0.0:3903"`, the token in `GARAGE_ADMIN_TOKEN`, on Docker 29.8.2,
Apple silicon. With `curl`, then with `apps/api/src/cli/storage-init.ts` (Bun 1.4.2):

| Call | Result |
|---|---|
| `GET /v2/GetClusterStatus`, right token | `200`; one node, `role: null`, `layoutVersion: 0` |
| the same, wrong token | `403` |
| `POST /v2/UpdateClusterLayout` (`zone: local`, `capacity: 1000000000`) | `200`, the change staged |
| `POST /v2/ApplyClusterLayout` (`version: 1`) | `200`; the node then has its role |
| `POST /v2/CreateBucket` (`globalAlias`) | `200`, with the bucket's id |
| `GET /v2/GetBucketInfo?globalAlias=` a missing bucket | `404` |
| `POST /v2/ImportKey` (the deployment's `GK…` id and secret) | `200` |
| the same key imported again | `409` — so the step reads first (`GetKeyInfo`, `404` when missing) |
| `POST /v2/AllowBucketKey` (read, write, owner) | `200`, the key listed on the bucket |
| an anonymous `GET` of the bucket on the S3 port | `403` |
| the key, through Bun's `S3Client`: write, read back, delete | `hello` read back |

`storage-init.ts` against that node: a fresh store → `layout, bucket, key, rights set up`; run again
→ `nothing to do`; a wrong token → `reading the cluster: the admin API answered 403`, exit 1; a
missing variable → named, exit 1.

**The whole stack, one command.** The API image built from the branch, `docker compose -f
docker-compose.production.yml --env-file … up -d --wait` with fresh secrets and `APP_URL` on
`https://localhost:8443`: `storage-init` exited `0` (`layout, bucket, key, rights set up`), the API and
the scheduler came up healthy, `/health/ready` answered `200` through the proxy, the API wrote, read
and deleted an object through its own configuration, every job of `jobs:status` was `ok`, the client,
`/push-worker.js` and `/api/auth/methods` were served — and a second `up` exited `0` with
`storage-init` saying `nothing to do`.

## What had to be loosened

Nothing in the code. The stack gained a listening port, 3903, on its private network only — published
nowhere, as the S3 port is not — and one more secret, `GARAGE_ADMIN_TOKEN`.

## What surprised us

**The production image did not build.** The Dockerfile copied `apps/web/src` but not
`apps/web/worker`, which #539 made an entry of the client build: `Cannot resolve entry module
worker/push-worker.ts`. CI's image job would have said so, but CI had not run since billing stopped
it; nothing local builds the image. Fixed in the same change, and the build above is the proof.
