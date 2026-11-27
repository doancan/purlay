# D-287. PDF attachments are read on request inside the conversation, with an owned worker and fresh authority — builds on D-109, D-113, D-210 and D-231

**Context.** The owner asked for chat improvements that serve small businesses and corporate departments as well as
software teams. Reading an invoice, quotation, delivery note or policy belongs in that conversation; it does not make
Purlay an ERP or a document editor. The actual renderer/native-viewer experiments and resolved versions are in
`docs/spikes/pdf-preview.md`.

**Decided.**

1. A PDF within the bounds of `features/chat/messages/pdf-limits.ts` offers the existing Preview beside its download.
   It opens one inline reader, replacing another open PDF, so the conversation stays visible. Previous/next, direct
   page selection, Fit width, zoom, selectable text, Download and Close are the complete reading path. Its viewport's
   width comes from the conversation, never from the enlarged document; that distinction prevents a measured resize
   feedback loop. Image-only pages are named and say that they have no extracted text. Keyboard, focus and states are
   `UX.md`'s; the file keeps its own colours in both themes.
2. **The renderer and its worker are lazy.** The pinned PDF.js legacy build is a new client dependency justified by
   the spike: both current browser engines and actual Chromium at the product floor ran it under the document CSP;
   the sandboxed native alternative did not render the fixture. A small standard `Promise.withResolvers` compatibility
   operation is installed in both realms before the SDK evaluates; negative real-browser tests remove that API in
   each realm. Built fonts, CMaps and the JavaScript image decoders are same-origin assets under the installed SDK
   version. The optional native canvas dependency is not a server feature or an external preview service.
3. **Authorization belongs to every use.** `Api.attachmentBytes` uses the existing authenticated download. `Http.bytes`
   is a lazy transport seam that counts actual streamed bytes, cancels on overflow or abandonment, bounds error JSON
   separately and preserves typed server refusals. It requests cache revalidation, holds no query/persistent byte cache,
   and passes bytes to the SDK, not a URL. Open, reconnect and return from a hidden tab start a new read. Closing,
   hiding, losing the connection or unmounting the containing message/channel clears the canvas/text and terminates
   the worker. A late download is discarded before parsing; a late parser result is closed. The server's attachment
   headers, session/channel/workspace guards and authority-before-304 remain D-109/D-231's, unchanged.
4. **Only one page is allocated.** Compressed bytes, document page count, decoded image pixels, canvas pixels/sides,
   displayed dimensions, extracted text/items and operation time are bounded by the code-owned reader limits. Text
   is counted from a stream before it becomes DOM. Canvas device resolution is clamped before allocation. Fetch,
   worker initialization and drawing cannot wait forever: timeout/failure ends the operation and hard-terminates the
   owned worker even if the SDK cleanup throws or never settles. A failed or partial page is not Ready. Requests for
   a newer page/size are serialized; stale completions cannot present themselves as the selected page.
5. **A quiet SDK failure has an explicit guard.** The pinned SDK's public operator/render promises resolved with an
   empty page when an image exceeded `maxImageSize`, despite `stopAtErrors`. The owned worker's stream-error packet
   (`stream: 5`) was observed separately and now rejects the operation. A recognized image-cap reason explains the
   limit; unfamiliar reasons are an unreadable page. Failed image decoders take a second silent-success path:
   `obj`/`commonobj` packets resolving an `Image` to `null`. These reject as unreadable too. This is an internal
   protocol coupling, bound by real over-limit and unavailable-decoder browser regressions and guard-removal
   mutations. Updating the SDK must repeat that proof and the spike, not merely change the manifest.
   No dependency source is patched.
6. **Document content remains data.** No document scripting manager, form runner, annotation/editor UI or XFA is
   instantiated; WebAssembly and dynamic font-face installation are disabled. Embedded scripts do not execute. There
   is no blob/eval/CDN allowance or relaxed document CSP. Password-protected, malformed and over-limit files retain
   an explicit explanation and download; no password is collected or stored. A missing application chunk offers a
   page reload and the existing download. No endpoint, DTO, database row or persisted format is added.
7. **Trusted built workers have an explicit response policy.** The isolated spike served worker entries with the
   document policy. Actual application testing found the API's data-only default CSP was inherited by its worker,
   blocking the same-origin decoder and font/CMap fetches. Vite now names dedicated entries `assets/*.worker.js`;
   only trusted files of the client build with that suffix receive `default-src 'none'; script-src 'self';
   connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, including on `304`. Ordinary
   assets, API responses, HTML documents and user attachments retain their existing policies. This generic static
   serving rule does not name a module. The worker cannot import external, inline, eval or WebAssembly code.

**Rejected with evidence.** A native capability flag as proof of a painted PDF, or a sandboxed iframe: the native
matrix produced blank frames under conditions in which the flag claimed support. An SDK image-size option alone:
the controlled document became a successful white page. Keeping PDF bytes indefinitely because an attachment id is
immutable: the content's immutability does not preserve the reader's membership (D-231). An external document
conversion service, editing, annotations, OCR, password storage and purchasing workflows are outside this task.

**Cost of reversing.** Revert the client reader, lazy dependency, build assets and worker response rule. Existing files, their metadata,
download URLs and the previous client remain valid; no schema or public protocol rollback is needed. Exact historical
Safari/iOS and Firefox releases were not available in the initial spike; current WebKit is not presented as those
releases. The browser floor is unchanged and the compatibility tests exercise the missing required API explicitly.
