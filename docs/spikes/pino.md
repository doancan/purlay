# Spike — pino

**2026-10-08.** Run in a scratch directory with `pino` installed alone, and in throwaway probe
files under `apps/api` against the repository's Elysia. Nothing in the repository was modified by
the spike itself. Recorded because D-57 lets a tool into `ARCHITECTURE.md` §2 on a spike, not on
an argument (#127).

## Versions resolved

| | |
|---|---|
| Bun | 1.4.2 |
| `pino` | 10.3.1 — not 10.4.0, published six days earlier; a version this young is not pinned |
| Elysia | 1.4.30 |

`bun add pino@10.3.1` installed 14 packages (`pino`'s own dependency tree). No transport or worker
thread is used: lines go to a synchronous destination on standard output.

## What was measured

| Question | Result |
|---|---|
| JSON lines on Bun | Yes, one per call |
| A key redacted at any depth, in arrays and nested objects, through `formatters.log` | Yes |
| **A child logger's bindings redacted by `formatters.log` and `formatters.bindings`** | **No.** `child({ email })` wrote the address with both hooks set |
| **An `Error` field written legibly once a formatter has rewritten the object** | **No.** It became `{}`: an error's fields are not enumerable |
| `pino`'s default `err` serializer after the object is cleaned | Rewrites it: `type` becomes `"Object"`, the cause is folded into the message |
| `AsyncLocalStorage` context across awaits, two interleaved requests | Kept apart: each line carried its own request's id |
| `AsyncLocalStorage.enterWith` from Elysia's `onRequest`, 20 concurrent requests, `handle()` and a real listener | 0 crossed contexts in both; the error hook sees the request's context too |
| When `onAfterResponse` runs | One tick after `handle()` resolves, and for errors and unknown routes as well |
| Cost: 100 000 lines, synchronous, to `/dev/null`, with a recursive cleaning pass | 241 ms — about 2.4 µs a line |

## Commands and output

```
$ bun run spike.ts
{"level":"info","time":"2026-10-08T09:06:53.400Z","user":{"email":"[redacted]","name":"x"},"token":"[redacted]","nested":[{"content":"[redacted]"}],"msg":"redaction"}
{"level":"info","time":"2026-10-08T09:06:53.408Z","requestId":"r2","step":"after await","msg":"in r2"}
{"level":"info","time":"2026-10-08T09:06:53.424Z","requestId":"r1","step":"after await","msg":"in r1"}
{"level":"warn","time":"2026-10-08T09:06:53.424Z","socketId":"s1","msg":"child"}
100k lines to /dev/null, sync, with scrub: 241 ms

$ bun run spike2.ts
{"level":30,"email":"leak@x.y","msg":"bindings, log formatter only"}
{"level":30,"email":"leak@x.y","msg":"bindings, both formatters"}
{"level":30,"err":{},"msg":"an error object"}

$ bun run apps/api/probe/als.ts
handle(): 20 concurrent requests, mismatched contexts: 0 []
error path: { seenInError: "errreq", error: "Error: x" }
listen(): mismatched: 0
```

## What this decided

- **The library's hooks are not where redaction lives.** A facade (`platform/logging.ts`) cleans
  every field and every binding before handing anything to `pino`, and owns error serialisation;
  `pino`'s `err` serializer is replaced with the identity. Each finding above has a test.
- **Request scope is `AsyncLocalStorage`**, entered from `onRequest` for HTTP and run around each
  socket frame (D-71).

## What had to be loosened

Nothing. No lint rule, budget or type check was relaxed to adopt it; the two defects found are
closed in the facade rather than worked around.
