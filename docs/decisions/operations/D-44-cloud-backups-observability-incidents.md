# D-44. Operating the cloud: backups, observability and incidents

D-1 previously refused all of this. It is now the product, so it gets specified rather than
improvised at the first outage.

**Backups.** Point-in-time recovery on PostgreSQL, plus object-storage versioning. A stated RPO and
RTO, published to customers. **A restore is tested on a schedule and the test result is recorded**
— an untested backup is a belief, not a backup.

**Observability.** `ARCHITECTURE.md` §10 already fixes structured JSON logging with a request id
and a never-logged list; the library is `pino`, named here because §10 required the behaviour and
no document named the tool. Added for the cloud: error tracking with a Sentry-compatible client,
external uptime monitoring against `/health/ready`, and a public status page.

**Self-hosters get the same instrumentation, disabled by default and pointing nowhere.** No
telemetry is collected from a self-hosted deployment, ever — D-1's third audience exists because
the operator owns the data, and phoning home would end that.

**No metrics stack yet.** Logs, health checks and error tracking answer *is it up* and *what
broke*. A time-series stack answers *how is it trending*, which nobody is asking until there are
customers to trend. `CONTRIBUTING.md` §1.11 applies to us.

*Amended 2026-10-31 by D-221:* the API serves a Prometheus page for the operator's own scraper, off until
`METRICS_TOKEN` is set; nothing is sent anywhere, so the paragraph above on self-hosters still holds.

**Incidents.** A written severity scale, a status-page update before a root-cause analysis, and a
public post-incident note for anything customer-visible. Written now, while it is cheap and
nobody is angry.
