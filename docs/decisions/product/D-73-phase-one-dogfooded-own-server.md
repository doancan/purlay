# D-73. Phase 1 is dogfooded on the team's own server — provisionally, and portably

**Amended by D-197:** dogfooding is a practice, not the thirty-day gate this entry describes.

S-1 gates Phase 1: the team stops opening Slack for thirty consecutive days. That requires the team
to be *using* Purlay during Phase 1, on an instance somebody runs — and the self-host path, with its
operator documentation, is Phase 2 (`PRD.md` §4). Without a decision here, Phase 1 would finish with
nothing to dogfood it on.

**Decided, for now: one server the team already operates.** A single node — the same shape as any
self-hosted instance (D-7, D-25): the API, PostgreSQL and object storage behind one origin with TLS.
What this pulls into Phase 1 is an *internal* deployment, not Phase 2's public one: a container image,
a production compose file, migrations on start, the built client served from the origin, and a
backup that has been restored once. Operator documentation for strangers stays in Phase 2.

**Provisional, and built so changing it is a move rather than a rewrite.** Nothing in the deployment
may assume this server: configuration only through the variables in `CONFIG.md`, state only in the
database and the bucket, no host paths in the application. Moving to a VPS or a platform is then a
matter of where the same image runs.

**Reopened when any of these happens** — watched by whoever owns the deployment issue (#224):
the server cannot give the instance its own TLS origin; dogfooding needs availability the server
does not have (the thirty days of S-1 are not interrupted by the host); a backup cannot be restored
from it; or Phase 2.5's cloud begins, which runs elsewhere by definition (D-44).

**Rejected, for now: a PaaS.** It would answer the hosting question and leave the self-host path
untested by the people writing it; dogfooding on the shape a self-hoster runs is part of what S-1
proves. **Rejected: waiting for Phase 2's self-host path.** S-1 cannot start until something runs.
