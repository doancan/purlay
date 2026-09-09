/**
 * `apps/api` — Bun + ElysiaJS, one process.
 *
 * The composition root, and the only file that reads the environment or opens a
 * connection. Everything below takes what it needs as an argument, which is what
 * makes it testable without a process (D-46).
 *
 * Layering is `ingress → modules → platform`, enforced by lint rather than by
 * convention (`ARCHITECTURE.md` §4).
 */
import { createDatabase } from '@purlay/db';
import { loadConfig } from './platform/config';
import { systemClock } from './platform/clock';
import { githubClient } from './modules/auth/github';
import { createApp } from './ingress/http/app';

const config = loadConfig(process.env);

const app = createApp({
  config,
  clock: systemClock,
  database: createDatabase({
    connectionString: config.DATABASE_URL,
    poolSize: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  }),
  github: githubClient({
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    // One origin, so this is the origin the browser is already on (D-61).
    redirectUri: `${config.APP_URL}/auth/github/callback`,
  }),
});

app.listen(config.PORT);
