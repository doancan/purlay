# D-75. Thumbnails are made with the runtime's own `Bun.Image`

D-36 and `ARCHITECTURE.md` §2 left the thumbnail library undecided, with the reason written down:
native image libraries are Bun's most common incompatibility, and finding that out in Phase 1 would
be expensive (#6). The spike (`docs/spikes/image-pipeline.md`) ran three installable libraries and the
runtime's built-in against generated fixtures, on macOS and in a Linux container.

**Decided: `Bun.Image`.** Nothing is installed, so there is no native binary to build in the image, no
platform package to resolve, and no dependency to audit — the cost D-36 expected to pay does not
arise. Orientation is applied and all metadata is stripped from what it writes; a 30000×30000 PNG that
is 2.6 MB on disk is refused by default before it is decoded.

**Three rules the spike earned, which the upload path (#53, #54) inherits:**

- A thumbnail is made with `{ fit: 'inside' }` and one bound. `resize(width, height)` means *exactly
  this size* and stretches.
- An image is valid when it **decodes**, not when its header parses — a truncated file passes
  `metadata()` and fails only when read. That failure is a rejection, not a server error.
- The default `maxPixels` guard is somebody else's default. The upload path states its own bound.

**Rejected — `sharp`.** It works under Bun, and is the more established library. It is also a native
dependency with a prebuilt binary per platform, which is the thing this spike existed to avoid, now
paid for nothing. **Rejected — `jimp`:** pure JavaScript, so portable, and slow enough to matter on a
25 MiB upload with no native fallback. Neither was benchmarked against the built-in, because the
built-in met every requirement; a rejection that rests on cost is stated as such, not as a measurement.

**Reopened when** `Bun.Image` misses a requirement a Phase 1 test finds — an animated thumbnail, a
format it cannot write — or when it breaks on a Bun upgrade. The upload path keeps it behind one
function, so replacing it is a change to that function.

**Reversibility:** free until thumbnails are stored; after that, existing thumbnails stay valid whatever
produced them.
