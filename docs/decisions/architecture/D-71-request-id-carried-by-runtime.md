# D-71. A request's id is carried by the runtime, not passed through every signature

D-47 required a request id that flows through HTTP, the socket and service calls from the first
handler, and warned that threading it through signatures afterwards touches every one (#127).

**Decided: `AsyncLocalStorage`.** Each HTTP request is entered as a scope from the framework's first
hook, each socket frame is run inside one, and the logger reads the id from the scope it is called
in. A service several calls down that has never heard of a request writes lines that carry its id.
Measured before it was relied on: twenty concurrent requests, through `handle()` and a real
listener, never saw each other's scope, and the error hook saw the failing request's
(`docs/spikes/pino.md`).

**Rejected: a context parameter on every service.** It is the cost D-47 named — every signature —
and it is worse than cost: a request is a transport concept, and the layering rule exists so that
nothing below the doors knows one exists (`ARCHITECTURE.md` §4). A parameter would put it into
every module's arguments to serve a logger.

**Rejected: an id only at ingress.** The line a service writes about why it failed is the one an
operator needs to join to the request that caused it.

**The cost** is implicitness: a line's id comes from where it is called, not from what it is
passed. That is the trade every tracing system makes for the same reason, and it is contained in
one module with tests that cross requests on purpose.
