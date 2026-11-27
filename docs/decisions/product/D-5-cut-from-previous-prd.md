# D-5. Cut from the previous PRD

| Removed | Reason | Where it went |
|---|---|---|
| Cross-workspace DM | Broke `workspace_id NOT NULL` in three documents at once, and lets a member of org A message org B outside A's admin visibility. Enterprise deal-breaker; Slack needed a decade and Slack Connect to do this safely. | Deleted. See D-6. |
| Personal scratchpad | A DM to yourself does the same job with zero additional schema, UI or code. | Folded into DMs. |
| Magic-link auth (MVP) | Second auth path means account-linking logic (same email via GitHub *and* email — same person?), which is a classic account-takeover surface. Also needs email infrastructure and deliverability work. | Phase 2. |
| GitHub webhook repo feeds (MVP) | Signature verification, delivery dedup, retry and replay is ~2 weeks of work and is *not* the wedge. Unfurling is. | Phase 2. |
| Tauri desktop (MVP) | Adds Rust toolchain, Apple Developer account + notarization, auto-update infrastructure and a second release channel — to gain notifications (Web Push already does this), a global shortcut and a dock badge. | Phase 3. See D-14. |
| Redis (MVP) | Single-node Bun needs no external broker. | Phase 3. See D-7. |
| "Sub-millisecond" search claim | Not achievable and not measurable as written. | Rewritten. See D-10. |
| "<35MB idle memory" | Not achievable with a real React app in WKWebView. | Replaced with real budgets. See D-17. |
| macOS-only Phase 1 | Excluding Linux from a developer tool needs a reason we do not have. | Web-first is platform-neutral. |
