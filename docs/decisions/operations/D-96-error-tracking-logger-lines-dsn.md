# D-96. Error tracking is the logger's `error` lines, sent on if a DSN is set — no SDK, off by default

D-44 specified error tracking for the cloud and it did not exist (#248). Left to grow, it would arrive
as a vendor SDK, a second description of every error beside the log's, and a default someone forgot to
turn off on a self-hosted instance.

**Decided: the logger is the only seam.** `withErrorTracking` wraps it so that whatever is logged at
`error` — a failed request, a failed socket frame, a failed shutdown — is also reported, and what is
sent is the same value `clean` produced for the log: nothing on the never-logged list, at any depth, and
the id of the request it happened in. There is no second place an error is described, so no second place
a secret can leak from. A new `error` line anywhere is reported without being touched.

**Off means absent.** With no `ERROR_TRACKING_DSN` the logger is returned as it came and no tracker
exists; nothing leaves the process (D-44: no telemetry from a self-hosted deployment, so there is no
default). A DSN that does not parse, or is not `https://` in production, **refuses to start**, naming the
variable and never repeating the key — the alternative is a deployment that believes it is reporting.

**No vendor library.** A Sentry-compatible envelope (accepted by Sentry and GlitchTip) is one `POST`
over `fetch`. It can never make the process worse: a report that cannot be delivered is counted and
handed to `onFailure`, logged at `warn` (an `error` there would be reported in turn), never retried in a
loop; at most ten are in flight and a burst beyond that is dropped and counted rather than queued, because
an error storm is when memory is least available; a bug in the tracker is caught, logged and ignored by the
caller; shutdown waits for what is in flight.

**Rejected: the vendor SDK.** A runtime dependency with its own supply chain and auto-instrumentation that
patches `fetch` and the HTTP server, for one `POST`. **Rejected: reporting from `onError` in the
framework.** It covers one path and describes errors a second way; the socket router, shutdown and every
future call site would need their own. **Rejected: retrying failed reports.** The log has the line; a retry
queue is memory held during the incident. **Rejected: grouping, sampling and breadcrumbs.** The receiving
service does the first two, and breadcrumbs are request content, which the never-logged list exists to keep
out.

**Not done:** stack frames are sent as the stack text in `extra`, not parsed into frames, so the receiving
service groups by message and type rather than by frame; source maps are not applicable to a server that
runs its source. The client's errors (`apps/web`) are a separate surface and not covered.

**Reversibility:** free. One module and one variable; unset it and the process is as it was.


*Amended 2026-10-09 (a second-round audit that pointed it at a collector that accepts and never answers):*
"it can never make the process worse" was not true of three things. (1) A report had no timeout, so ten
silent connections held every slot for ever: of 25 failing requests ten were delivered and no error was
ever reported again until restart, nothing said reports were being dropped, and SIGTERM ran to the whole
ten-second deadline. A report now gives up after five seconds; drops are announced at `warn`, at most once a
minute, with the running total; and shutdown waits for the reporter two seconds at most and abandons what
is left. A redirect is not followed (`redirect: 'manual'`): a report goes to the host in the DSN and
nowhere else. (2) Stack traces named the machine — `/Users/…`, `/home/…`, the build directory. Absolute paths
are made relative to the working directory, to the package inside `node_modules`, or to the file name
alone, in the stack, the message and every string in the fields; a request path such as `/api/channels`
is not a place on the machine and is left alone. Run again: 25 failing requests, ten delivered, one drop
notice, the next five delivered after the timeout, SIGTERM answered in two seconds.

**Amended 2026-10-13 (#492) — the client's render failures.** Still not reported to the tracker, and
still no client endpoint or SDK for it: that would be a new service for what this decision left out on
purpose. What changed is where a failure lands: a boundary around the routed screen, inside the shell
and keyed by the address, so the rail and the sidebar outlive it; and one directly under the words, for
anything else that can still be said in the person's language. Each offers Reload and Go home as full
loads. The report is React's own, to the console. **Rejected:** a boundary above the words — it could
only speak English, and the catalogue that failed is what it would need.
