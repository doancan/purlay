# Spike — one API process at PRD §5's build target (2026-10-13)

`PRD.md` §5 says its budgets are measured at the Phase 0–2 build target: **300 concurrent sockets, 20
messages a second at peak, one API process**. `bun run budget:latency` measures the ACK and fan-out
budgets on two sockets (D-49). Nothing had measured them at the target. This runs it, and twice it.

## What was run

A real API process (`bun apps/api/src/index.ts`, `NODE_ENV=development`, the production budgets and
limits, `DATABASE_POOL_MAX=10`) against a clone of the integration database, on one machine with the
load generator:

- `SOCKETS` people, each with a session and one socket, all members of one channel and subscribed to
  it. People and workspace memberships were inserted directly; the channel was made and joined over
  HTTP.
- Twenty of them send in turn, `RATE` messages a second in all for 30 s, so no person exceeds the
  write budget (10/s, D-81).
- An ACK is timed on the sender's socket. Delivery is timed on twenty sampled listeners; every other
  listener receives and counts frames without parsing them, so the generator's parsing is not what is
  measured.
- The API's RSS is read with `ps` during the run.

With the script at the end of this file saved as `apps/api/src/cli/.spike/capacity.ts` (it imports
the API's modules by relative path) and the integration database up:

```
DATABASE_URL=postgres://purlay:purlay@localhost:5432/purlay bun apps/api/src/cli/.spike/capacity.ts
SOCKETS=600 RATE=40 … (the same)
API_LOG_LEVEL=info … (the same, with the production log level)
```

**Versions:** Bun 1.4.2, PostgreSQL 18 (compose), Apple M4 Pro (14 cores), main at f47849c.

## Results

| Load | Log level | ACK p50 / p95 / max | Fan-out p50 / p95 / max | Delivered | RSS: sockets open → peak |
|---|---|---|---|---|---|
| 300 sockets, 20 msg/s | warn | 17.1 / **21.1** / 47.3 ms | 12.3 / **15.7** / 42.1 ms | 600/600 ACKs; 360,300 frames | 111.6 → **128.2 MiB** |
| 300 sockets, 20 msg/s | info | 16.6 / **19.1** / 36.7 ms | 12.0 / **14.3** / 32.1 ms | 600/600; 360,300 frames | 112.0 → **135.6 MiB** |
| 600 sockets, 40 msg/s | warn | 14.6 / **17.1** / 47.4 ms | 7.6 / **10.1** / 36.7 ms | 1,200/1,200; 1,440,600 frames | 120.4 → **166.5 MiB** |

The budgets are 120 ms (ACK p95) and 200 ms (fan-out p95). At the target the server is at about a
sixth and a fourteenth of them, and still well inside them at twice the target. Every message reached
every socket: frames received = messages × sockets, plus the subscriptions' answers.

## What surprised us

- **Memory under load is past the idle budget.** The 120 MB budget is for idle RSS (`budget:api`,
  72–80 MiB measured). With 300 sockets open the process holds about 112 MiB before a message is sent,
  and 128–136 MiB at the target load. Nothing in `PRD.md` §5 bounds memory under load. A deployment
  sizing its server to the idle number would be short. Recorded rather than budgeted: whether to set
  a loaded-memory budget is the owner's (O-4's family of numbers).
- **Latency fell as the load doubled.** The p50s were lower at 40 msg/s than at 20. Most likely the
  event loop stays warm, the same effect `budget:latency` shows on a cold start. It means these numbers
  are not a curve, and only the order of magnitude should be read from them.

## What this does not show

- **A server's CPU.** It ran on a 14-core laptop, with the load generator on the same machine. A small
  VPS has a fraction of that. The margin (a sixth of the budget) is the claim, not the numbers.
- **Several channels, threads, reactions, mentions.** One channel and plain roots: the fan-out is the
  worst case for one message, not a realistic mix.
- **Reconnect storms.** All sockets were opened once; a node restart that brings 300 back at once is
  drained (D-72) and rejoins with jitter (D-82), and is not measured here.
- **The proxy.** Caddy was not in the path.

## What had to be loosened

Nothing in the API. The generator inserted people and memberships directly into the database, so it
did not spend 300 people's write budgets on setup; every send and every socket went through the real
API with the production budgets.

## The script (throwaway)

```ts
/** Capacity spike (throwaway): PRD §5's build target — 300 sockets, 20 messages/s, one API process. */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { cloneIntegrationDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { issueSession } from '../../modules/auth/sessions';

const SOCKETS = Number(process.env['SOCKETS'] ?? 300);
const RATE = Number(process.env['RATE'] ?? 20);
const SECONDS = Number(process.env['SECONDS'] ?? 30);
const SENDERS = 20;
const SAMPLED = 20;

const p = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * q) - 1)] ?? NaN;
};
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address(); server.close();
  if (a === null || typeof a === 'string') throw new Error('no port');
  return a.port;
};
const clone = await cloneIntegrationDatabase();
const port = await freePort();
const origin = `http://localhost:${String(port)}`;
const api = Bun.spawn(['bun', 'apps/api/src/index.ts'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(port), APP_URL: origin, DATABASE_URL: clone.connectionString,
    GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y', ENCRYPTION_KEY: randomBytes(32).toString('base64'), LOG_LEVEL: process.env['API_LOG_LEVEL'] ?? 'warn', DATABASE_POOL_MAX: '10' },
  stdout: 'inherit', stderr: 'inherit',
});
const rss = (): number => Number(Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(api.pid)]).stdout.toString().trim()) / 1024;
const sockets: WebSocket[] = [];
try {
  for (let i = 0; i < 600; i++) { if (await fetch(`${origin}/health/ready`).then((r) => r.ok, () => false)) break; await Bun.sleep(100); }
  const people: { id: string; cookie: string }[] = [];
  for (let i = 0; i < SOCKETS; i++) {
    const { id } = await clone.db.insertInto('users').values({ email: `cap${i}@spike.test`, username: `cap${i}`, display_name: `cap${i}` }).returning('id').executeTakeFirstOrThrow();
    const { token } = await issueSession(clone.db, systemClock, id, 1);
    people.push({ id, cookie: `${SESSION_COOKIE}=${token}` });
  }
  const owner = people[0]!;
  const post = async (cookie: string, path: string, body: unknown): Promise<any> => {
    const r = await fetch(`${origin}${path}`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
    return await r.json();
  };
  const ws = await post(owner.cookie, '/api/workspaces', { name: 'cap', slug: `cap-${randomBytes(3).toString('hex')}` });
  await clone.db.insertInto('workspace_members').values(people.slice(1).map((p) => ({ workspace_id: ws.id, user_id: p.id, role: 'member' as const }))).execute();
  const ch = await post(owner.cookie, `/api/workspaces/${ws.id}/channels`, { name: 'all' });
  for (const person of people.slice(1)) await post(person.cookie, `/api/channels/${ch.id}/join`, {});
  console.log(`rss after setup: ${rss().toFixed(1)} MiB`);

  const sentAt = new Map<string, number>();
  const acks: number[] = []; const fans: number[] = [];
  let frames = 0;
  for (let i = 0; i < SOCKETS; i++) {
    const s = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { cookie: people[i]!.cookie, origin } } as unknown as string[]);
    await new Promise<void>((ok, no) => { s.addEventListener('open', () => ok()); s.addEventListener('error', () => no(new Error('socket'))); });
    const sampled = i >= SENDERS && i < SENDERS + SAMPLED;
    s.addEventListener('message', (e) => {
      frames++;
      if (i >= SENDERS && !sampled) return;
      const f = JSON.parse(String(e.data)) as { event: string; refId?: string; data?: { id?: string } };
      const now = performance.now();
      if (i < SENDERS && f.event === 'ACK' && f.refId !== undefined) { const t = sentAt.get(f.refId); if (t !== undefined) acks.push(now - t); }
      if (sampled && f.event === 'MESSAGE_CREATED' && f.data?.id !== undefined) { const t = sentAt.get(f.data.id); if (t !== undefined) fans.push(now - t); }
    });
    const id = messageId(new Date());
    s.send(JSON.stringify({ id, op: 'SUBSCRIBE', payload: { channels: [{ channelId: ch.id, afterMessageId: null }] } }));
    sockets.push(s);
  }
  await Bun.sleep(2000);
  console.log(`${String(SOCKETS)} sockets open; rss: ${rss().toFixed(1)} MiB`);
  const peak: number[] = [];
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < SECONDS * 1000) {
    const sender = sockets[n % SENDERS]!;
    const id = messageId(new Date());
    sentAt.set(id, performance.now());
    sender.send(JSON.stringify({ id, op: 'MESSAGE_SEND', payload: { channelId: ch.id, content: `load ${String(n)}` } }));
    n++;
    if (n % RATE === 0) peak.push(rss());
    const due = start + (n * 1000) / RATE;
    await Bun.sleep(Math.max(0, due - performance.now()));
  }
  await Bun.sleep(3000);
  console.log(`sent ${String(n)} at ${String(RATE)}/s for ${String(SECONDS)} s; frames received ${String(frames)}`);
  console.log(`ACK      p50 ${p(acks, 0.5).toFixed(1)} p95 ${p(acks, 0.95).toFixed(1)} max ${Math.max(...acks).toFixed(1)} ms (${String(acks.length)}/${String(n)})`);
  console.log(`fan-out  p50 ${p(fans, 0.5).toFixed(1)} p95 ${p(fans, 0.95).toFixed(1)} max ${Math.max(...fans).toFixed(1)} ms (${String(fans.length)}/${String(n * SAMPLED)} sampled deliveries)`);
  console.log(`rss under load: max ${Math.max(...peak).toFixed(1)} MiB; after: ${rss().toFixed(1)} MiB`);
} finally {
  for (const s of sockets) s.close();
  api.kill('SIGTERM'); await api.exited; await clone.drop();
}
```
