# Security policy

Purlay is team chat software that holds a team's conversations. A vulnerability in it is taken
seriously, and this page says how to report one and what to expect.

## Supported versions

Purlay has not made a release yet (the first is `v0.1.0`). Until it does, only the latest commit
on `main` is supported: a fix lands there and nothing is backported. After the first release,
the latest minor version is supported, and this table is updated with each one.

| Version | Supported |
| --- | --- |
| `main` | yes |
| any release | none yet |

## Reporting a vulnerability

**Please report privately. Do not open a public issue, pull request or discussion for a
vulnerability.**

Use GitHub's private vulnerability reporting: on the repository, open **Security**, then
**Report a vulnerability**
(`https://github.com/doancan/purlay/security/advisories/new`). That opens a private thread with the
maintainer, lets us work on a fix in a private fork, and publishes an advisory with credit to you
when it is fixed.

Helpful in a report: the affected commit or version, what you did, what you expected, what
happened, and a minimal way to reproduce it. A report that lacks some of it is still welcome.

If the **Report a vulnerability** button is not shown, private reporting is not enabled on the
repository you are looking at; open an issue titled only "security contact please", with no
details, and a private channel will be arranged.

## What to expect

Purlay has one maintainer, so these are targets that one person can keep, not an on-call promise.

| Step | Target |
| --- | --- |
| Acknowledgement that the report was read | within 5 working days |
| First assessment: accepted, needs more information, or declined, with reasons | within 14 days |
| A fix or a mitigation for a confirmed high-severity issue | within 30 days of the assessment |
| A fix for a confirmed lower-severity issue | in the normal release cycle |
| Public advisory | when the fix is released, or after 90 days from the report, whichever is first, agreed with you if it needs to differ |

If a date will be missed, you will be told before it passes, with a reason.

## Scope

In scope: the code in this repository, the container image it publishes, and the configuration it
ships (`docker-compose.production.yml`, the workflows).

Of particular interest, because the product's promise depends on them: access across workspaces or
to channels the caller is not a member of (the API returns 404, never 403, for a resource that is
not theirs), session and OAuth handling, the WebSocket origin check, attachment serving, and
anything that leaks a secret into a log.

Out of scope: findings that need a modified client of your own on the victim's machine, denial of
service by volume alone (the capacity ceiling is documented in `docs/DECISIONS.md` D-25), and
vulnerabilities in a dependency that have no path into Purlay (report those upstream; the
dependency audit in CI watches them).

## Safe harbour

Good-faith research that follows this policy, avoids other people's data, and does not degrade a
running service will not be met with legal action.

## How the supply chain is held

Actions are pinned to commit SHAs, `bun audit` blocks at high severity
with an expiring allowlist, CodeQL scans on every change, and dependency licences are checked
against AGPL-3.0 distribution.
