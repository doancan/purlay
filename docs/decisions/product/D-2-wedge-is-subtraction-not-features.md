# D-2. The wedge is *subtraction*, not features

Purlay wins on four axes, in this order:

| Axis | Concrete meaning | How it is measured |
|---|---|---|
| **Simplicity** | No apps directory, no workflow builder, no huddles, no canvas, no AI summaries. One way to do each thing. | Every feature pays an admission cost — a budget, a matrix cell, a removal condition (D-250); the non-goals in `PRD.md` §6 stand |
| **Speed** | Typing→render is never blocked on the network. Cold load and interaction budgets in `PRD.md` §5. | Measured budgets, enforced in CI |
| **Cost** | Self-hosted. No per-seat fee. **No message history limit** — Slack's free-tier 90-day cutoff is the single most cited pain. | $0 per seat; full history retained |
| **Dev-native** | Code, diffs and GitHub links are first-class objects, not attachments-with-syntax-colors. | Qualitative, judged by dogfood team |

**Positioning against the field** — this is honest, not flattering:

- **Slack** — the incumbent we are subtracting from. We lose on integrations, calls, mobile,
  enterprise features. We win on cost, history retention, and RAM.
- **Zulip** — the closest competitor and a genuinely better threading model than ours
  (topic-per-conversation, enforced). We do **not** claim to beat Zulip on threading. We differ
  by being lighter to run and operate, and by treating GitHub as a first-class citizen rather
  than a bot integration. *A team that is happy in Zulip is not our user.*
- **Discord** — free and already where devs are, but it is a community tool, not a work tool:
  no self-hosting, no data ownership, hostile to async.
- **Mattermost / Rocket.Chat** — self-hostable but they chased enterprise parity and inherited
  Slack's complexity. Our differentiator is what we refuse to build.

**We are not attempting to beat Slack.** We are attempting to be sufficient for a
5–30 person engineering team that resents paying for Slack and loses knowledge to its
history limit.
