# Purlay — Roadmap (`ROADMAP.md`)

Ordered execution plan. Scope per phase is fixed by `PRD.md` §4; this file breaks it into
tasks and states what "done" means for each.

**Working rule:** a task is done when it is typed, tested, and its documentation is accurate —
not when it runs. A phase is done when its exit criterion is demonstrated, not when the task
list is ticked.

---

## Phase 0 — Walking Skeleton

**Exit criterion:** two browser tabs, signed in as two different GitHub users, exchange a
message in real time — and the message is still there after the API restarts.

### 0.1 · Foundation
- [ ] Bun workspaces + Turborepo; `apps/api`, `apps/web`, `packages/{types,db,config}`
- [ ] Shared tsconfig with `strict: true`; ESLint rule enforcing `ingress → modules → platform`
- [ ] `docker compose`: PostgreSQL 16 + MinIO
- [ ] `@purlay/db`: Kysely client, migration runner, migrations `0001`–`0006` (`SCHEMA.md` §12)
- [ ] `platform/uuid`: UUIDv7 generator **and validator**, shared by client and server (D-8, D-33)
- [ ] Thumbnail library spike: confirm a Bun-compatible image pipeline before Phase 1 (D-36)
- [ ] Config loader that validates every environment variable at boot and refuses to start otherwise

### 0.2 · Contracts
- [ ] `@purlay/types`: `models.ts`, `events.ts` (`ClientFrame`/`ServerFrame`), `api.ts`
- [ ] TypeBox schemas for every frame and request body

### 0.3 · Identity
- [ ] GitHub OAuth with `state` verification (`ARCHITECTURE.md` §7.1)
- [ ] `sessions`: opaque token, SHA-256 at rest, HttpOnly cookie
- [ ] `WorkspaceContext` guard — the branded type that makes an unscoped query fail to compile
- [ ] `ChannelContext` guard — the same mechanism on the channel-visibility axis (D-34)
- [ ] Session validation on WebSocket upgrade, before the socket is bound

### 0.4 · First vertical slice
- [ ] `modules/workspaces`: create, membership, role
- [ ] `modules/channels`: create public channel, join, list
- [ ] `modules/messages`: send, keyset history page
- [ ] `realtime/`: `InProcessEventBus`, socket hub, frame router
- [ ] Message id validation: v7 shape, timestamp bound, conflict verified before ACK (D-33)
- [ ] `MESSAGE_SEND` → one transaction → commit → publish → `ACK` (`ARCHITECTURE.md` §5.3, D-35)
- [ ] Client clock offset from `ServerFrame.ts`, applied to id generation (D-33)
- [ ] Reconnect with backoff + replay by keyset cursor

### 0.5 · Minimal client
- [ ] Sign-in, workspace and channel list
- [ ] Message list with keyset pagination and a composer (`UX.md` §2, §3, §5)
- [ ] Scroll anchoring and the unread marker (`UX.md` §6) — rules hold regardless of O-5
- [ ] Zustand socket store; optimistic send with `sending`/`sent`/`failed` and a retry action
- [ ] TanStack Query for history and hydration — no `fetch` inside `useEffect` (D-18)

### 0.6 · Proof
- [ ] Integration tests against real PostgreSQL and real migrations
- [ ] **Cross-tenant isolation test returning 404** (D-21)
- [ ] **Intra-workspace visibility test returning 404** (D-34)
- [ ] Realtime test: two sockets, ordering, ACK, reconnect replay, duplicate-send idempotency
- [ ] Schema-drift test: Kysely types vs. applied migrations
- [ ] CI: `typecheck` + `lint` + `test`

---

## Phase 1 — MVP

**Exit criterion (S-1):** the owner's team stops opening Slack for internal discussion, and
stays off it for 30 consecutive days.

### 1.1 · Threads — the wedge
- [ ] `THREAD_REPLY`, inline expand/collapse under the parent in the main feed (`UX.md` §4)
- [ ] `THREAD_RESOLVE`; auto-collapse on resolve; resolved threads stay searchable
- [ ] Maintain `thread_reply_count` / `thread_last_reply_at` on write (never `COUNT(*)`)
- [ ] Workspace-wide "open questions" view (`idx_messages_unresolved`)
- [ ] Enforce invariant I-1: threads are at most two levels deep

### 1.2 · Content
- [ ] Server-side GFM parse at write time → `metadata` + `mentions` (`ARCHITECTURE.md` §8.1)
- [ ] Sanitizer: no raw HTML, no `javascript:`, external images proxied
- [ ] `CodeBlock`: language badge, line count, clamp above 12 lines, copy-raw
- [ ] Highlighting synchronous by default, Shiki grammars loaded lazily; Worker **only where a
      measurement shows a dropped frame** (D-36)
- [ ] Client render memoised per `(message.id, edited_at)`; shared server/client fixture suite (D-36)
- [ ] Message edit and delete (tombstone, never erase) — resolves O-1
- [ ] Emoji reactions

### 1.3 · Channels, DMs, membership
- [ ] Private channels; DMs with `dm_key` (invariant I-5); self-DM as the scratchpad
- [ ] Invitations — resolves O-2
- [ ] Roles and the permission matrix (`ARCHITECTURE.md` §7.4); invariant I-2
- [ ] Per-channel `notification_level`

### 1.4 · Attachments
- [ ] `POST /api/uploads`; MIME and size validation against `attachment_size_limit`; quota check
- [ ] Paste-to-upload, thumbnails, brokered downloads, orphan sweeper
- [ ] Invariant I-7: `storage_used_bytes` reconciliation job

### 1.5 · Noise control
- [ ] Mentions → `notifications`; `@here`/`@channel` rejected by the parser
- [ ] **Participation notifications**: a reply notifies the root author and prior repliers (D-29)
- [ ] Notification inbox; unread and unread-mention counters (invariants I-3, I-6)
- [ ] Deep Work: server-side suppression, `suppressed_by_deep_work`, auto-expiry
- [ ] `PresenceRegistry` and `RateLimiter` behind their interfaces (`ARCHITECTURE.md` §6.1, §6.2)
- [ ] Rate limiting — resolves O-4

### 1.6 · Navigation and search
- [ ] `Cmd/Ctrl+K` palette over channels, DMs, people, settings
- [ ] Scoped substring search on `idx_messages_search`, narrowed to visible channels, keyset (D-34)
- [ ] Full keyboard navigation, visible focus, WCAG AA

### 1.7 · GitHub unfurl
- [ ] Workspace-level credential, encrypted at rest
- [ ] Unfurl endpoint with `link_previews` cache and **negative caching**
- [ ] `GitHubCardMetadata` card rendering

### 1.8 · Administration and scheduled work
- [ ] Migration `0009_administration.sql`: `audit_log`, `job_runs`, `workspaces.retention_days`
- [ ] `audit.service`: every administrative action writes exactly one row (D-26, invariant I-9)
- [ ] `GET /api/workspaces/:workspaceId/audit`, admin-only, keyset
- [ ] CLI runner + the Phase 1 jobs: `sweep:orphans`, `sweep:link-previews`, `sweep:sessions`,
      `reconcile:storage`, `jobs:status` (D-30)
- [ ] Scheduler container wired into `docker compose`, `job_runs` written on every run

### 1.9 · Quality gates
- [ ] Performance budgets measured and enforced in CI (`PRD.md` §5)
- [ ] Permission test per role-gated action
- [ ] Decide O-5 (list virtualization) from real dogfooding data

---

## Phase 2 — Community-ready

**Exit criterion (S-2):** a stranger self-hosts it from the README without opening an issue.

- [ ] One-command self-host: `docker compose up`, migrations on boot, first-run setup
- [ ] Operator documentation: backup, restore, upgrade, storage, environment reference
- [ ] Web Push — closes the Phase 1 gap where a closed tab is silent
- [ ] GitHub webhook repo feeds: signature verification, delivery dedup, retry (migration `0010`)
- [ ] Unified/split diff viewer for ` ```diff ` blocks
- [ ] Magic-link auth (migration `0011`); account-linking rules written before any code
- [ ] Message edit history
- [ ] Retention policy (`purge:retention`), account erasure and content erasure (D-27, I-10, I-11)
- [ ] Workspace export: NDJSON per table plus attachment blobs (D-27)
- [ ] Operator compliance documentation: data map, retention runbook, erasure runbook (D-28)

---

## Phase 3 — Polish

- [ ] Tauri desktop shell; measured against the real budgets, not the deleted 35 MB claim (D-14)
- [ ] `RedisEventBus`, `SharedPresenceRegistry`, `SharedRateLimiter` behind the existing
      interfaces; sticky-session load balancing (D-7, D-25)
- [ ] OIDC single sign-on — only if an operator asks (D-31)
- [ ] Mobile client

---

## Not on this roadmap, ever

Audio/video/WebRTC · screen sharing · app marketplace · visual workflow builder · AI
summarization · E2E zero-knowledge encryption · SAML · per-seat billing.

Refusing these is the product. Full list and reasoning: `PRD.md` §6.
