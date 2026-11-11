# Browser CI container spike — 2026-11-11 (#1402, D-304)

## Failure reproduced

PR runs 43035228864 and 43043411945 failed during browser dependency installation, before tests.
Chromium job 130601018408 and WebKit job 130601018091 each exhausted three bounded attempts with
DNS errors for both archive.ubuntu.com and azure.archive.ubuntu.com. APT priority already preferred
archive; reversing it would not repair both unresolved names.

## Actual Linux run

Source: reviewed reconnect repair `777da6db46877067144d13cd4b3ca0b84245b7ea`.
Official image: `mcr.microsoft.com/playwright:v1.64.1-resolute`, immutable multi-architecture digest
`sha256:f76885029244e5a384243a930ff283cef67d90653978ee27a77dd4cff8882fb4`.
The matching client came from the frozen repository install. Linux browser and client processes
shared direct host networking, without `PW_TEST_CONNECT_EXPOSE_NETWORK` or a loopback proxy. The
browser server mounted the source volume read-only. The client used Bun 1.4.4 and the repository's
unchanged real API, test database and production-build Playwright configuration.

Command: `bun --no-env-file run test:e2e -- visual.e2e.ts channel-settings.e2e.ts push-worker.e2e.ts audit.e2e.ts --workers=2`
with the existing WebKit project enabled.

Result: **56 passed, 4 existing skips, 0 failed**; Playwright 59.7 seconds, full client lifecycle
101.06 seconds. Chromium's dark/light wide/narrow visual goldens were asserted without modification.
The run also exercised archive/reconnect/WebSocket routing, real CSV downloads on both engines,
and Chromium service-worker/CDP behavior. No test retry, timeout, skip, golden or bound changed.
Only this spike's client/server containers and source volume were removed afterward.

A rejected Mac-client prototype used Playwright loopback forwarding to reach Mac-hosted endpoints:
Chromium passed, but WebKit's download timed out. That proxy is absent from the chosen Linux topology;
the actual Linux WebKit download passed. Hosted performance and complete suites remain CI's authority.

## Operational checks

The composite action refuses mismatched client versions, invalid Docker ids, failed starts,
unready endpoints and a stopped owned container. Its id survives startup failure for the always-run
cleanup; only a ready server endpoint reaches test steps. Both jobs clean up their recorded id.
Action-path changes must run browser CI. Unit tests run the actual shell with failure-producing external
commands; guard-removal mutations must fail. The full browser matrix retains its existing commands,
artifacts, screenshot baselines, isolated measurements and regression thresholds.

The image contains browsers/system dependencies but uses the repository's Playwright package, as
[official Docker guidance](https://playwright.dev/docs/docker) prescribes. Updating its digest and client
is an ordinary reviewed change; Docker registry availability remains a setup dependency.
