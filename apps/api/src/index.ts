/**
 * `apps/api` — Bun + ElysiaJS, one process.
 *
 * The composition root, and the only file that reads the environment. Everything
 * below takes what it needs as an argument, which is what makes it testable
 * without a process (D-46).
 *
 * Layering is `ingress → modules → platform`, enforced by lint rather than by
 * convention (`ARCHITECTURE.md` §4).
 *
 * **The database handle is not built here yet.** Nothing needs one: `/health` is
 * liveness and must answer while the database is down. It arrives with the first
 * route that needs it, which is the rule the configuration loader already
 * follows — a thing is wired when the feature that needs it exists (D-57).
 */
import { loadConfig } from './platform/config';
import { createApp } from './ingress/http/app';

const config = loadConfig(process.env);
createApp().listen(config.PORT);
