# D-7. Real-time fan-out is in-process for now, behind an interface

Phase 0–2 run a single API process. Fan-out is an in-memory topic registry. All publish/
subscribe goes through one `EventBus` interface so that swapping in Redis/Valkey for Phase 3
is a single adapter, not a refactor.

**Rejected:** Redis from day one. It buys nothing on one node and adds a service to install,
monitor and reason about during the phase where velocity matters most.

**Also decided:** presence and typing indicators are **ephemeral and in-memory**. They are
never persisted and are allowed to be wrong after a restart.

**Amended 2026-09-09.** The cloud (D-1) cannot run on one process with an uptime commitment, so
the shared adapter is no longer a Phase 3 contingency — it is required before the cloud carries
paying customers. **The self-hosted product is unchanged and stays broker-free**: a team of thirty
on one box will never need it, and making them install Redis to use free software would be a
betrayal of the third audience. One interface, two deployments, and the decision to run a broker
belongs to whoever operates the instance.
