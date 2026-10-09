# Spike — the image pipeline

**2026-10-09.** Thumbnails and downscaling are Phase 1 work (D-16, `ARCHITECTURE.md` §9), and native
image libraries are the most common Bun incompatibility, so the choice was run before it was written
down. Three candidates were installed into a scratch directory and one built-in was probed:

| Candidate | Resolved | Result |
|---|---|---|
| `Bun.Image` | built into Bun 1.4.2 | **Works on macOS and Linux, no dependency** |
| `sharp` | 0.35.5 | Installs and runs under Bun; used here as the independent reader of every output |
| `@napi-rs/image` | 1.15.0 | Installs; not exercised further — the built-in made it unnecessary |
| `jimp` | 1.6.1 | Installs; pure JavaScript, not exercised further for the same reason |

## Verdict

**`Bun.Image`, with nothing installed.** It reads JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC and AVIF,
writes JPEG, PNG, WebP, AVIF and HEIC, and resizes. Every behaviour below was checked against a second
implementation (`sharp`) reading the *output*, not against the library describing itself.

## Where it ran

| | `Bun.Image.backend` | Platform |
|---|---|---|
| Developer machine | `system` | macOS, arm64 |
| `oven/bun:1.4.2` container | `bun` | Linux, aarch64 |

**The two platforms use different decoders**, which is why the Linux run exists: a library that
behaves on the laptop and differently in the container is the failure this spike is for. The same
fixtures gave the same dimensions, formats, errors and pixel statistics on both. The container is the
shape a self-hoster runs (D-73); the cloud's architecture (x86-64) was **not** run and is the one gap.

## Fixtures

Generated with `sharp`: a 4000×3000 JPEG carrying EXIF orientation 6 and a copyright tag; a
semi-transparent PNG; a WebP; a GIF; a **30000×30000 PNG that is 2.6 MB on disk** (a decompression
bomb); a JPEG truncated at 5000 bytes; a text file named `.jpg`; an empty file.

## What it does, observed

| Input | Result |
|---|---|
| JPEG with orientation 6, `resize(256)` | 256×341 — **rotated upright**; the output has no orientation tag and **no EXIF at all** |
| Same, `resize(256, 256)` | 256×256 — **stretched**, not cropped or fitted (see below) |
| Same, `resize(100, 100, { fit: 'inside' })` on a 400×200 source | 100×50 — aspect kept |
| Semi-transparent PNG → WebP / PNG | alpha preserved |
| Semi-transparent PNG → JPEG | alpha dropped, no error |
| GIF → PNG | first frame |
| 30000×30000 PNG, `metadata()` | **refused: `Image: input exceeds maxPixels limit`** — by default, before any decode |
| Same, with `{ maxPixels: 1e9 }` | accepted: the limit is a default, so it is a decision somebody can undo |
| Truncated JPEG, `metadata()` | succeeds (the header is intact) — **`decode failed` only when the pixels are read** |
| Text file named `.jpg`, empty file | `unrecognised format` — decided by content, not extension |
| Resize 4000×3000 → 256 wide | 10–12 ms on both platforms |
| Upscale 1200×800 → 4000 wide | works, 270–410 ms: **nothing stops an upscale** |

## What this means for Phase 1

- **Stripping EXIF is free and total.** The output carries none — GPS position, camera serial and
  copyright tag all gone — which is what a screenshot-paste product wants and was not promised by
  anything we wrote. It is also something an *original* download would not do, so the stored original
  keeps its metadata unless the upload path strips it separately (#53, #54).
- **`metadata()` succeeding does not mean the image decodes.** The upload path validates by producing
  the thumbnail, and treats `decode failed` as a rejection (`400`), not as a server error.
- **Never `resize(w, h)` for a thumbnail.** It stretches. Use `{ fit: 'inside' }` and one bound, so the
  aspect ratio survives; a test with a non-square, two-coloured source is what proves it (the fixture
  here was half red, half blue — a solid colour cannot show a stretch).
- **The `maxPixels` default is the decompression-bomb defence and must not be raised.** The upload
  path should still bound the *declared* dimensions itself, with a number in `SCHEMA.md` §7.2, before
  trusting a default that belongs to somebody else's release.
- **An upscale must be refused by us** — a 1200-pixel image requested at 4000 costs 300 ms and adds
  nothing.

## What had to be loosened

**Nothing.** No compiler flag, lint rule, cast or suppression was involved: the scratch directory was
outside the repository and the repository's `package.json` is unchanged, because the chosen candidate
is not a dependency. That is stated rather than left silent: "nothing" and "I did not look" read the
same otherwise.

## What surprised us

- **The built-in exists at all.** The spike was scoped to choosing among native libraries, and the
  answer was that none of them is needed.
- **`resize(w, h)` distorts.** Both dimensions together mean *exactly this size*. Easy to write, wrong
  for every photo that is not already the target shape.
- **A truncated file passes `metadata()`.** Validating by reading the header would accept it.
- **The default bomb guard works on a 2.6 MB file** — the check is on declared pixels, not on size, so
  the usual "the file is small" reasoning is exactly what it does not use.

## Not run

- x86-64 Linux (the likely cloud shape). The decoder is the same `bun` backend as the aarch64 run, but
  that is an inference.
- Animated GIF/WebP output (only the first frame is ever read).
- Memory under concurrent resizes. Phase 1's upload endpoint is rate limited and size capped; whether a
  burst of 25 MiB uploads is survivable is a measurement for #53, with the budget it sets.
