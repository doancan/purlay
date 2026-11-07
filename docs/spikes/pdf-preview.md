# PDF attachment reader

2026-11-07 · #1222 · implementation candidate, not a completed feature.

Resolved: PDF.js (`pdfjs-dist`) 6.5.438; Bun 1.4.4; Vite 8.3.5;
Playwright 1.64.1. This record describes actual experiments, not a compatibility
matrix inferred from package metadata. The isolated work lives under
`/tmp/purlay-pdf-preview-research`; product acceptance tests must make the important
results durable before this task can merge.

## What ran

The same document CSP as the application, a real dedicated worker and same-origin
assets, without an iframe, blob URL, CDN, eval allowance or document script runner.
`disableFontFace: true`, `useWasm: false`, `enableXfa: false`,
`useSystemFonts: true`, `stopAtErrors: true` were used. The library receives bytes,
not a URL to fetch. Font paths rather than dynamically installed font faces render
embedded fonts under the existing policy.

- Current Chromium and Playwright WebKit rendered a self-authored invoice, its
  embedded-script variant and a two-page Turkish/Arabic invoice with embedded
  fonts and a vector table. The script did not execute. Encrypted and malformed
  inputs rejected with `PasswordException` and `InvalidPDFException`.
- Both pages of a self-authored scanned fixture rendered under the same policy:
  JPEG/DCT and JPEG2000/JPX. Actual canvas quadrant pixels were checked. JPX fetched
  `openjpeg_nowasm_fallback.js` from the same origin; no WebAssembly was fetched.
- The legacy display and worker also ran in **actual native Linux arm64 Chromium
  120.0.6099.224**, installed from signed Debian Bullseye archive packages in a
  disposable container with no external network. Both scans rendered, and the
  over-limit image control below failed visibly. The official Chrome for Testing
  120.0.6099.109 macOS packages crashed before application code on this newer host;
  that was not counted as a PDF failure or a successful compatibility test.
- A Vite production build targeted the application's unchanged browser floor.
  The reader was a dynamic import and the worker a built ES module. Before Preview
  the network contained only HTML, entry JS and CSS, no reader, worker or document.
  After Preview, both invoice pages rendered with selectable text and nonzero
  text-span geometry in current Chromium and WebKit. Ten spans on the first page
  carried `dir=rtl`. Visual output was inspected. This is not a claim about screen
  reader reading order in every untagged PDF.
- The production candidate passed twelve current-engine cases (two engines × two
  pages × control/missing-document-API/missing-worker-API), then the same six cases
  in actual Chromium 120. A small standard `Promise.withResolvers` shim ran in
  **both realms** before the legacy library. Without that shim, separately removing
  the method had already produced a main-thread TypeError or an unresolved worker
  load with a TypeError. Fault injection is not emulation of old Safari.

Commands included `bun --no-env-file vite build --config <isolated config>`,
`bun --no-env-file vite-compat-browser-spike.mjs`, and
`docker run --rm --read-only --network=none … purlay:pdf-chromium120-probe
/research/vite-compat-chromium120-spike.mjs`. Logs are `vite-compat-build.log`,
`vite-compat-browser-results.log`, `vite-compat-chromium120-results.log` and
`pdfjs-chromium120-linux-guard-results.log` under that experiment directory.

## The quiet failure found

`maxImageSize: 1` intentionally refused a valid 64×64 image, with
`stopAtErrors: true`. Public `getOperatorList()` and render promises nevertheless
resolved, producing an empty white page, on both current engines. Disabling worker
rendering did not change that. A diagnostic copy of the worker proved the actual
cap branch ran; the installed dependency was not modified.

An owned, unmodified SDK worker sends a stream error packet with `stream: 5` and a
`reason`, even in that case. Observing it before handing the worker port to
`PDFWorker` and racing public operations against the fatal error made both scans
fail visibly before Ready; the valid controls still rendered. This is an
**internal protocol dependency**, not a documented API guarantee. Pin the version,
hold it to a real negative browser regression and repeat the spike on upgrades.
Do not suppress the error or accept a blank page as a successful preview.

## Measured cost and limits of the evidence

The final isolated Vite build emitted the reader at **501,611 bytes / 151,250 gzip**,
worker implementation **1,251,424 / 385,722**, worker entry **357 / 237** and the
shared compatibility shim **207 / 171**. Font/CMap and decoder assets were emitted
separately and fetched only as needed. The JPX JavaScript fallback measured
338,458 / 89,512 in the earlier raw-asset measurement. These are not the application's
initial-bundle measurement: its own budget still has to be run after integration.

The isolated experiment left the product browser floor, document and attachment
headers, download authentication, deadlines and budgets unchanged. It served the
worker with the document CSP; that differs from the actual application's original
data-only worker response, found during integration below. The worker enables
cancellation of parsing; it is not a new server service.

Actual Safari/iOS 17.2 and Firefox 121 were not available for an exact historical
browser run. Current WebKit is not proof of those releases. The compatibility shim,
project compatibility lint, production target and negative tests are required;
browser-specific failures must remain explicit rather than silently blank. Large
document/decompression bounds, timed termination, revocation, real chat UI, zoom,
focus, narrow layout and accessibility acceptance remain to be proved in the feature.

## Actual application integration

The chat attachment flow initially failed the scan's second page in every tested
project. WebKit reported that the worker's inherited `default-src 'none'` blocked
the JavaScript JPX decoder. The first isolated spike had not exercised the API's
static response policy. D-287 records the correction: a generic trusted build suffix
(`*.worker.js`) with a dedicated worker CSP allowing only same-origin script and
data. It adds no blob, eval, WebAssembly or external origin allowance; HTML, ordinary
assets, API and attachment response policies stay unchanged. Real router tests bind
the response and its `304` to that exact policy, and a real production build test
binds the worker filename to the router's contract.

The SDK also resolves failed image decoding as a null `Image` dependency through
`obj` and `commonobj` packets, while publicly resolving render successfully. The
reader rejects those pinned packets as unreadable. A real browser test aborts the
JPX decoder request, first verifies a painted JPEG page, then requires an explicit
error and terminated worker on the second page. It cannot pass on a white canvas.
The positive scan test checks actual quadrant pixels on both pages.

The committed fixtures are self-authored, without third-party business documents:
`e2e/pdf-fixture.ts` builds the two-page invoice, vector content and embedded-script
negative control, plus a compressed 4097×4097 image just beyond the 16-million-pixel
cap. `e2e/fixtures/scanned-codecs.pdf` contains two 64×64 red/blue quadrant images,
encoded as JPEG and JPEG2000 with Pillow in the isolated experiment. The 1,901-byte
`password.pdf` is an AES-256 copy of the self-authored invoice, generated with
pypdf 6.14.2 and cryptography 50.0.2; its fixture password is `preview-test`.
Those generators are experiment tools, not application dependencies.

Eight real WebKit cases passed after the integration fixes: lazy open, page/zoom/
text-selection/keyboard/axe, both scan codecs, unavailable decoder, missing
`Promise.withResolvers` in both realms, malformed/encrypted input, 320px at 400%,
membership revocation and over-limit image. The test file runs its independent
cases in sequence: running seven UI uploads at once exceeded the existing node
limit of four, positively observed as `429` with the upload-cap message. Product
upload limits and test deadlines were not increased. The complete engine/theme
matrix and final gates are recorded in the pull request when they finish.

## Native alternative actually tried

Full current Chromium in new-headless mode rendered the fixture in an iframe only
without the iframe sandbox. Adding the sandbox prevented rendering. Standard
headless Chromium and Playwright WebKit produced blank frames even when the
reported PDF capability was true. This rejects capability flags and a sandboxed
native iframe as sufficient evidence for this application; it does not claim every
real Safari browser lacks a native PDF viewer.

Primary references: [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
[upstream browser policy](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions),
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/),
[Debian Chromium sources](https://sources.debian.org/src/chromium/).
