# D-20. Stack confirmed, and its costs written down where they can be seen

*Amended by D-219: Dependabot opens no pull requests; updates are the owner's.*

Keeping Bun + ElysiaJS + Kysely + PostgreSQL + React + Vite + Tailwind + Zustand. Each is
defensible for this project.

The problem with the earlier draft was not the choices but the justification: its "Architectural
Rationale" column was written *after* the choices were made, listed only benefits, and named no
cost. That is marketing copy, and it makes a document untrustworthy — a reader cannot tell which
choices were weighed and which were assumed.

**Decided:** every stack row carries the cost we knowingly accepted, stated plainly.

**Rejected:** Node + Fastify (safer, but Bun's WebSocket engine and startup time are the point);
Drizzle and Prisma (both reintroduce a runtime layer over SQL); Redux (heavier than the
optimistic buffer needs).

> **Single source of truth:** the stack table with accepted costs lives in `ARCHITECTURE.md` §2.

**Amended 2026-09-09 — versions, and the one choice that got riskier.**

**Target the latest stable major and say so.** The documents said PostgreSQL 16, released in 2023.
The target is **PostgreSQL 18** (released 2025-09-25, supported to 2030-11), and everything else
is pinned to its current stable line. *Which* line each one is on is not written here — that is
the manifest's answer, and D-56 removed the copies. A stack table with a version nobody checked is
how a project arrives at launch three majors behind; a stack table with a version nobody
*installed* is how it arrives believing things it never ran.

**TypeScript 7 compiles the code; the TypeScript 6 API serves the linter. Both are checked.**

The naive reading is that these are alternatives. They are not — `typescript-eslint` hard-fails on
TypeScript 7 (`typescript-eslint does not support TS 7.0`), and its own error message points at the
side-by-side setup TypeScript 7 shipped for exactly this. Verified rather than assumed:

```
devDependencies: {
  "@typescript/native": "npm:typescript@…",          // provides `tsc`
  "typescript": "npm:@typescript/typescript6@…"      // provides `tsc6` and the 6.0 API
}
```

The exact pins are in `package.json`, which is the only place they are. `tsc` gates the build.
`require('typescript')` resolves to the 6.0 API, so
`no-floating-promises` and the `no-unsafe-*` family — the entire mechanism D-47 rests on — keep
working. Neither is given up.

**The cost, and it is real: two type systems are now in the toolchain.** The compiler that gates
the build and the one the linter reasons with can in principle disagree, and TypeScript 7 aims at
behavioural parity rather than guaranteeing it. That risk is made *detectable* instead of accepted:
**CI typechecks with both**, so a disagreement is a failed build rather than a confusing lint
result. This is the same move as every other decision in D-47 — a risk that is checked is not a
risk that is remembered.

**ElysiaJS, measured.** D-20 called it the highest-risk choice and never ran it. It was run on
2026-09-09 (`docs/spikes/elysia.md`): it typechecks under both compilers, lints clean under the
full strict rule set, and needed **nothing loosened**. One finding goes on the risk row rather than
into nobody's head — **its own published `.d.ts` files produce 104 errors under this project's
strictness**, so its compatibility is contingent on `skipLibCheck: true`. That flag stays on: it
says "we do not typecheck other people's shipped declarations", which is ordinary and is not an
escape hatch of ours. What is not ordinary is not knowing, and now it is written down. The Hono
trigger is unchanged and now has a real data point beside it rather than an intuition.

**Trigger to collapse back to one compiler:** `typescript-eslint` supporting TypeScript ≥ 7.1
(upstream issue 10940). At that point the alias, the second typecheck and this paragraph all go.

**Something has to watch for that.** A written trigger nobody checks is a wish, so dependency
updates arrived weekly as grouped pull requests that passed the same gate as everything else
(`.github/dependabot.yml`; D-219 ended them and removed the file, so the owner's own update commits take that place). That is also what keeps *target the latest stable major* true six
months from now rather than only on the day it was written.

*Noted, not adopted:* PostgreSQL 18 ships a native `uuidv7()`. D-8 requires the **client** to
generate the id so the optimistic row and the durable row share one value, so the server function
is not used — but the column type and ordering assumptions are now backed by the database's own
implementation rather than only by ours.

**ElysiaJS is now the highest-risk choice in the stack, and it stays.** §2 already accepted
"smaller community, docs move fast". That was a cheap cost for a side project and is a real one
for a service with an uptime commitment (D-1). It stays because the end-to-end type safety in
`ARCHITECTURE.md` §1 is built on Elysia's TypeBox integration, and no equivalent exists elsewhere.
**Hono is the written fallback** — it runs on Bun, has far wider deployment, and is runtime-
agnostic. **Trigger:** if a security fix or a Bun-major compatibility fix is unavailable for more
than four weeks, the ingress layer moves. It is one layer by design (`ARCHITECTURE.md` §1, tenet
3: protocols are adapters, not architecture), which is what keeps that move survivable.

**Named because the documents required the behaviour and never named the tool:** `pino` for the
structured JSON logging `ARCHITECTURE.md` §10 mandates (D-44).
