# Docker-less setup with native Postgres Implementation Plan

**Goal:** A contributor without Docker can run the development servers and the tests against a PostgreSQL they installed themselves, from steps written in `CONTRIBUTING.md` and linked from the README (#1313).

**Architecture:** Documentation only. The steps are the compose file's settings (`docker-compose.yml`: user, password and database `purlay`, `--locale=C --encoding=UTF8`, loopback only, a port that may be overridden) written as commands for a locally installed server, and they are run end to end on a real server before they are written down.

**Tech Stack:** PostgreSQL (`initdb`, `pg_ctl`, `psql`), Bun, the existing `.env.example` and `.env.test.example`.

**Spec:** the issue body: "Write the native Postgres steps (random port, data directory, env file) into CONTRIBUTING.md and link them from the README."

## Global Constraints

- The cluster is made `--locale=C --encoding=UTF8`: identifier columns declare `COLLATE "C"` and `/health/ready` refuses a server that disagrees (docs/CONFIG.md, D-40).
- The server listens on `127.0.0.1` only; its password is development-only, as the compose file's is.
- A free port is picked, never assumed (the issue says random; 5432 is often taken, PRD.md §3 S-2).
- One home per fact (CONTRIBUTING §6.1): the steps live in `CONTRIBUTING.md` §2; the README links, and the sentence "There is no Docker-free installation guide" goes.
- `.env` and `.env.test` keep their roles (§2): `.env` for `bun run dev`, `.env.test` only the server address.
- Docs only: no changelog entry, no mutation; `check:docs` must pass.

## Review Focus

- A data directory that already exists: the steps must not initialise over it.
- Port already in use: the picked port is checked free.
- Object storage: without Garage, uploads answer `503 STORAGE_UNAVAILABLE` unless `STORAGE_DIRECTORY` is set; the guide says which.
- Stopping and removing: how to stop the server and throw the data away (the `db:down` and `db:reset` twins).

## Task 1: Run the steps for real

- [ ] Make a cluster in a temp directory, start it on a free port, create role and database `purlay`, write the two env files, run `bun run db:migrate`, start `bun run dev`, read `/health/ready`, run one integration test file against it.
- [ ] Record what each command printed; any step that needed a change is changed here before it is written down.

## Task 2: Write the guide and link it

- [ ] `CONTRIBUTING.md` §2: a subsection "Without Docker" with the verified commands, the storage choice, stop and reset.
- [ ] `README.md`: replace the "no Docker-free installation guide" sentence with a link to that subsection.
- [ ] Verify: `python3 scripts/check-docs.py`, `bun run format:check`, `bun run check:branch`.
- [ ] Commit `docs(contributing): set up without Docker on a native PostgreSQL`; pull request says `Closes #1313`.
