# Spike — ElysiaJS

**2026-09-09.** Run in a scratch directory against a byte-identical copy of
`packages/config/tsconfig.base.json` and the repository's lint configuration. Nothing in the
repository was modified.

D-20 called ElysiaJS *"the highest-risk choice now that the cloud carries an uptime commitment"*
and wrote down Hono as the fallback. That risk had never been measured.

## Verdict

| Gate | Result |
|---|---|
| Typecheck, TypeScript 7 | passes, 0 errors |
| Typecheck, TypeScript 6 API | passes, 0 errors |
| Lint — `strictTypeChecked` + `stylisticTypeChecked` + this repository's additions | passes, 0 errors |
| Runtime — routes, validation, error handler | works |
| TypeBox interoperability | works, and better than expected |
| WebSocket upgrade rejected before the socket is bound | works, with a real HTTP status and body |

## What had to be loosened

**Nothing.** No compiler flag turned off, no lint rule disabled, no `any`, no `as`, no
`@ts-expect-error`, no `eslint-disable`. `exactOptionalPropertyTypes`, `erasableSyntaxOnly`,
`verbatimModuleSyntax` and `noPropertyAccessFromIndexSignature` all stayed on and all passed.

`explicit-function-return-type` does not fire on route handlers: `allowTypedFunctionExpressions`
exempts them, so the handler shape the framework wants does not fight the rule.

## The finding that matters

**ElysiaJS's own published type declarations do not typecheck under this repository's strictness.**
With `skipLibCheck: false` there are **104 errors** across seven of its `.d.ts` files, identical
under both compilers. One is a direct casualty of `exactOptionalPropertyTypes`:

```
node_modules/elysia/dist/cookies.d.ts:116:22 - error TS2420: Class 'Cookie<T>' incorrectly
implements interface '{ domain?: string | undefined; ... }'.
  Types of property 'secrets' are incompatible.
    Type 'string | (string | null)[] | null | undefined' is not assignable to type
    'string | (string | null)[] | null'.
```

`tsconfig.base.json` sets `skipLibCheck: true`, so this is invisible today. It is recorded because
it means the framework's compatibility is **contingent on that flag**, and that belongs in D-20's
risk row rather than in nobody's head.

## Three traps for the code that uses it

**A naive error handler turns every validation failure into a 500.** `ValidationError` is not our
`AppError`, so `if (error instanceof AppError) … else 500` sends a 422 to the catch-all. The
handler has to branch on the framework's `VALIDATION` code explicitly.

**The default validation response echoes the client's input and publishes the schema.** Unhandled,
a bad body returns 422 carrying `found: {what you sent}` and, for every issue,
`schema: {minLength, maxLength, …}`. It must be replaced with this project's envelope, which is
what `API.md` §1 already requires.

**Unknown properties are accepted.** `{title, body, surprise: 1}` returns 200 and `surprise` is
silently dropped: `Type.Object` does not set `additionalProperties: false` and the framework does
not add it. Closed by D-57 at the contract, not per route.

## Two things worth knowing

**There is one TypeBox, not two.** The framework declares `@sinclair/typebox` as a peer dependency
rather than bundling it, so `t.Object` **is** `Type.Object` — the same function object, verified at
runtime. A schema authored in `packages/types` passes to a route with no adapter and infers
narrowly rather than as `any`. An install deliberately forced to a version outside the peer range
still produced one copy and still typechecked; the two-copies failure class could not be
reproduced.

**Annotating the return type as the bare `Elysia` does not compile.** The type is invariant in its
routes, so `Elysia` with no routes is not assignable to `Elysia` with one. Found while writing the
real thing rather than here, because this spike never annotated it. The answer is to name the
surface the caller actually uses — `handle` and `listen` — which also keeps the framework's types
out of everything above ingress.

**Routes cannot be split into a function that takes or returns an application.** The invariance
above bites in both directions: an application carrying `/health` is not assignable to a parameter
typed as one carrying none. The library's own permissive alias, `AnyElysia`, is
`Elysia<any, …>` — passing a handler context derived from it produces **42 `no-unsafe-*` lint
errors**, because it launders `any` into every handler. The answer is to keep handlers
framework-neutral — a request in, a decision out — and do the routing in one file.

**Declaration emit grows with routes × error branches.** Under `composite: true`, the accumulated
route type lands in the emitted `.d.ts`, and because the error handler is global, *every* route's
response type carries the error union. Six trivial routes produced 5 KB.

This spike concluded that `apps/api` is referenced by nothing and should therefore drop
`composite`. **That was wrong about this repository** — the solution `tsconfig.json` references
`apps/api`, and a referenced project must be composite. Checked before acting on it. The emit is
kept small by the return-type annotation above instead.
