# D-336. Traces across a request, a job and a fact's delivery, without an SDK and off by default (#1307)

**Context.** `correlation_id` and `caused_by` link facts in the logs, but a request that publishes a fact that a consumer handles
that publishes another is three pieces of evidence in three places, and an incident that logs and metrics could not explain
needs one picture of it. A trace backend is something an operator has or has not; the product cannot assume one.

**Decision.**
1. **W3C Trace Context in, OTLP/HTTP JSON out.** A request's `traceparent` is joined (a malformed one is none), or a trace starts;
   spans are made for the request, a job's run and the delivery of a fact between modules, and sent to the collector named by
   `OTEL_EXPORTER_OTLP_ENDPOINT`. **Unset, tracing is off**: no span is made, nothing is stored, nothing is sent, and a call costs
   a comparison. `TRACE_SAMPLE_RATIO` (0.1) decides new traces from the trace's own id, so every node answers alike; a trace that
   arrives with a decision keeps it.
2. **No SDK.** `platform/tracing.ts` is a context, a tracer and a bounded exporter in one file. The idle-memory budget (`PRD.md` §5)
   is what the product has least of, and the SDK's is the cost this avoids; what is needed (ids, parent, times, a few attributes,
   a POST) is small and held by `tracing.test.ts`.
3. **What a span says is a list of eight names** (`ATTRIBUTES`): the route's pattern, the method and status, a module id, a fact's
   type and consumer and the outcome of its delivery, a job's name. Never a path with its ids, a query, a header, a body, a
   payload, a person or a workspace: a span goes to a system the workspace's members never agreed to. A name off the list or a value
   of the wrong kind is not kept.
4. **The exporter never costs a request.** The queue of ended spans is the process's own, in memory, bounded (2,048, the oldest
   dropped and counted); one export is in flight at a time, waits three seconds, never follows a redirect and is not retried; a
   failed batch is a count (`purlay_trace_spans_total{outcome}`). A restart loses a few seconds of spans, and says nothing else.
5. **The collector's credential** is `OTEL_EXPORTER_OTLP_HEADERS`, never in the address (refused at the start), never logged,
   never in a span.

**Rejected.** *The OpenTelemetry SDK:* its memory and its start-up against the idle budget, for an exporter this does in a page.
*Always on:* a cost and a flow of data nobody asked for. *Putting workspace or user ids in spans:* they are the first thing a
backend's operator would see; the route's pattern and a module are what an incident needs. *Retrying exports:* a collector that is
down is met with a growing queue and a storm when it returns.

**Cost of reversing.** Unset the endpoint, or remove `tracing.ts`, `tracing-start.ts`, the three hooks (request, job, delivery)
and the column that carries a trace to a fact's row.
