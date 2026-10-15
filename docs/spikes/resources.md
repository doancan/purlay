# Spike — each production container's memory, and Garage's fsync (2026-10-15)

#639 asked for two settings to be chosen from measurements rather than set by hand: a memory and
process bound on every container in `docker-compose.production.yml`, and whether Garage writes to the
disk before it acknowledges.

**Versions:** Bun 1.4.2, PostgreSQL 18.3, Garage v2.1.0, Caddy 2.11.7, Docker 29.8.2 (Docker Desktop on
an Apple M4 Pro, 14 cores, 7.7 GiB given to its VM). Main at 8b03ebb.

## Memory

| Container | Measured | How | Bound chosen |
|---|---|---|---|
| `api` | 53.5 MiB idle in the image; 136 MiB at the build target (300 sockets, 20 msg/s), 166 MiB at twice it | `scripts/image-smoke.sh` on a fresh image (`idle memory: 53.52MiB`); the loaded numbers are `capacity.md`'s | **768 MiB**, 256 processes |
| `scheduler` | 61.5–63.8 MiB per job process, one at a time, beside the scheduler's own | `/usr/bin/time -l bun apps/api/src/cli/jobs.ts <job>` for `jobs:status`, `sweep:orphans`, `purge:retention`, `reconcile:storage`, `sweep:deletions` | **512 MiB**, 128 |
| `storage-init` | one short Bun process, as a job | as above | **256 MiB**, 64 |
| `postgres` | 278 MiB after a day of the integration suite against it | `docker stats` on the development database | **1536 MiB**, 256 |
| `garage` | 6–30 MiB idle | `docker stats` | **512 MiB**, 128 |
| `proxy` | 20.7 MiB idle, 16 processes | `docker stats` on Caddy with the production Caddyfile | **256 MiB**, 128 |

Each bound is several times the measurement: it is there to stop a runaway taking the host, not to
size the server, and a normal day must never meet it. A container that meets its bound is killed and
`restart: unless-stopped` brings it back; the API drains on SIGTERM but not on an OOM kill, so its
clients reconnect and replay (D-72, D-82). Each is a variable (`API_MEMORY_LIMIT` …), documented in
`docs/CONFIG.md`, for a larger server.

**Not bounded: CPU.** A CPU quota throttles; a throttled API answers late, which the latency budgets
measure as a failure. Sharing the host's CPU is the better failure.

**PostgreSQL's number includes the page cache** its container reads through. Under a bound the kernel
reclaims cache before it kills, so the bound is on what PostgreSQL holds, not on how much it caches.

## Garage's fsync

`docker/garage.production.toml` set neither `metadata_fsync` nor `data_fsync`; Garage's default for
both is `false`, so a power cut can lose the metadata of files the API was told were stored. A PUT of a
256 KiB object, 200 one after another and 200 eight at a time, through Bun's `S3Client` against the
development Garage (the scratch script below), before and after recreating it with both set:

```
fsync off (default), run 1: sequential p50 2.1 p95 3.1 max 5.1 ms | 8 at a time p50 9.9 p95 12.2 ms, 165.4 MiB/s
fsync off (default), run 2: sequential p50 2.1 p95 3.2 max 4.0 ms | 8 at a time p50 9.7 p95 11.8 ms, 172.9 MiB/s
fsync on, run 1: sequential p50 2.0 p95 5.4 max 6.4 ms | 8 at a time p50 10.1 p95 13.6 ms, 160.0 MiB/s
fsync on, run 2: sequential p50 2.0 p95 5.7 max 6.3 ms | 8 at a time p50 10.3 p95 14.6 ms, 157.3 MiB/s
```

The median is unchanged, the 95th percentile gains about 2.5 ms and throughput about 6 % less — for an
upload that already crosses the network from a browser, nothing a person can see. **Both are set.**
That the recreated container read the changed file was checked from its mounts; the development
configuration was put back afterwards.

## What this does not show

- **A server's disk.** Docker Desktop's VM on a laptop SSD is not a VPS's network block storage, whose
  fsync can cost ten times more. The direction holds; re-measure on the server (#224) with the same
  script before trusting the numbers.
- **PostgreSQL at the team's real size.** 278 MiB is a test database's. `jobs:status` and `docker
  stats` on the server after the first week say whether 1536 MiB is wide enough.
- **A job on a large workspace.** The jobs were measured on development data; `purge:retention` and
  `reconcile:storage` work in batches, so their memory should not grow with the data, but that was
  not measured.

## What had to be loosened

Nothing.

## The scratch script

```ts
// Spike: PUT latency against the local Garage, sequential and 8 at a time. Usage: bun put-latency.ts <label>
import { S3Client } from 'bun';
const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: process.env.BUCKET ?? 'purlay-attachments',
  accessKeyId: 'GK000000000000000000000001',
  secretAccessKey: '0000000000000000000000000000000000000000000000000000000000000002',
});
const body = new Uint8Array(256 * 1024).map((_, i) => i % 251);
const pct = (xs: number[], p: number): number => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN;
const one = async (key: string): Promise<number> => { const t = performance.now(); await s3.write(key, body); return performance.now() - t; };
const run = `spike-${Date.now()}`;
for (let i = 0; i < 10; i++) await one(`${run}/warm-${i}`);
const seq: number[] = [];
for (let i = 0; i < 200; i++) seq.push(await one(`${run}/seq-${i}`));
const par: number[] = [];
const t0 = performance.now();
for (let b = 0; b < 25; b++) par.push(...(await Promise.all(Array.from({ length: 8 }, (_, j) => one(`${run}/par-${b}-${j}`)))));
const wall = performance.now() - t0;
const f = (n: number): string => n.toFixed(1);
console.log(`${process.argv[2]}: sequential p50 ${f(pct(seq, 0.5))} p95 ${f(pct(seq, 0.95))} max ${f(Math.max(...seq))} ms | 8 at a time p50 ${f(pct(par, 0.5))} p95 ${f(pct(par, 0.95))} ms, ${f((200 * 256) / 1024 / (wall / 1000))} MiB/s`);
for (const k of [...seq.keys()].map((i) => `${run}/seq-${i}`)) await s3.delete(k);
```
