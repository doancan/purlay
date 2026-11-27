# D-144. The production stack prepares its own object store on `up` — #76

**Context.** S-2 asks that a stranger self-host Purlay from the README. After `docker compose up` one
step remained, `scripts/production-init.sh`, which gives the Garage node its place in the layout and
makes the bucket and the application's key through Garage's CLI. Compose cannot run it: the Garage
image has no shell, and one service cannot exec into another (D-94, `docs/spikes/object-storage.md`).

**Decision.** A one-shot service, `storage-init`, runs `apps/api/src/cli/storage-init.ts` from the API
image on every `up`, after Garage is healthy, and the API and the scheduler wait for it to have
completed successfully. It drives Garage's admin API (`docs/spikes/garage-admin.md`), which listens on
the stack's network only and is authorised by a new secret, `GARAGE_ADMIN_TOKEN`. Each step reads
first and does only what is missing — the layout, the bucket, the key, its rights — so a later `up`
does nothing; then it checks that an anonymous read of the bucket is refused with `403`, and anything
else fails the run and holds the API back. The database already migrates as the API starts (D-93), and
the first person to sign in makes the first workspace (D-124): together, one command.

**Rejected.** *Running Garage's CLI from a second Garage container* — the CLI needs the node's id
before it can assign it, and without a shell nothing can pass one command's answer to the next.
*Baking the bucket and key into Garage's configuration* — Garage has no such setting; its state is
made by API or CLI. *Keeping the manual step and documenting it* — what S-2 counts is whether a
stranger succeeds, and a second command after `up` is the one people miss.

**Cost of reversing:** the service, the CLI, the admin listener and the variable; the stack works with
`production-init.sh` as before.
