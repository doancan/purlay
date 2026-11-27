# D-277. A module's web UI is one folder, `features/<id>`, and a lint fence and a test hold the client to it — builds on D-250, D-254; amends `MODULES.md` §6 and §9

**Context.** The API held a module to its folder; the web did not. Chat's UI was sixteen sibling folders under `features/`
(`channel`, `composer`, `messages`, `threads`, `sidebar`, `inbox`, `search`, `saved`, `pins`, `questions`, `unreads`,
`drafts`, `conversations`, `incidents`, `bookmarks`, `profile`) beside the three files in `features/chat`, and nothing stopped
a module importing another or the core importing a module: the core imported chat's folders in about forty places. `budget:web` named
eleven of chat's files by hand to say which must stay out of the shell.

**Decision.**

1. **Where a module's web code is.** `apps/web/src/features/<id>/`, the folder that holds the manifest. Chat's sixteen folders
   moved under `features/chat/` by `git mv` with the imports rewritten and nothing else, proved by a script that compared
   every file to its base (equal once each import specifier is replaced by the file it resolves to, every one resolving), and
   by the build: the chunks of the moved tree and the tree before it have the same content hashes.
2. **What is not chat's is shared.** Who a message is by (`lib/author.ts`: it is a rule about the contract's `Message` and
   `User`), the e-mail chip input, the author picker and a group's stacked faces (`ui/`: they import `ui` and `components`
   only) left chat's folders because the core, the setup wizard and the palette use them. `lib/` is new: code with no screen
   and no module in it that two folders use. `content/` (markdown and message rendering, used by release notes and settings) stays
   a core folder.
3. **The fence.** A module imports no other module. The core imports no module except `modules/registry.ts`, which imports
   each manifest and nothing else, and the files in `CORE_IMPORTS_OF_MODULES` (`scripts/web-fences.mjs`), each with its reason.
   Tests, and `testing/` which they are built with, may import a module: they compose the whole client and none ships. The
   fence is two things because ESLint sees one file and the specifier as written: the lint holds it per importing file
   (`no-restricted-imports` blocks made by `webFences`, found per folder with a manifest, as the API's are), and
   `web-fences.test.ts` holds it per import with the compiler's parser, so a path in a comment is not an import and a type is
   counted. The list **only shrinks**: the test fails for a core import that is not listed, for an entry that is no longer an
   import, for a duplicate or an entry with no reason, and for a list longer than its cap (24 after the first burn-down; a change that removes an
   entry lowers the number).
4. **What the list holds, and why it is not empty.** Eight overlays the shell opens (re-exported from `app/deferred.ts`, one
   lazy chunk, never in the shell); the sidebar's chat lists, the rail's inbox and open-questions entries and the two
   providers the shell mounts round every screen (an upload in flight and a save intent outlive the screen that began them),
   which are in the first frame inside `WhenRun module="chat"` — a lazy chunk for them was measured on 2026-11-03 and saved
   2% of the shell for a layout fallback; and a few functions the palette, the alerts and the welcome screen ask of chat's
   files. Each is the next step of a burn-down: a manifest slot for overlays and sidebar sections would end most of them.
   **Burn-down, first step (28 to 24):** a notification's reading (`whyOf`, `targetOf`: the inbox's rows and the background alert
   say one thing), the channel lists and their order (pure functions of the wire's `Channel`, which the sidebar, the palette
   and the welcome screen share) and the remembered last channel (a `localStorage` helper, like the language and the theme) are
   not chat's screens: they moved to `lib/` and `data/`, by a script that proved the files equal but for import paths. What is
   left is chat's by what it draws (the sidebar's lists, the rail's entries, the providers, the overlays), the palette's reading
   of search operators and `fold`; the next step is a manifest slot, not another move.
5. **The budget is derived.** `budget:web` no longer lists chat's files: every file under `features/<id>/` but the manifest,
   less what the core may import and what those files import statically (`screenSources`), must be absent from the initial
   chunks' source maps, for every module; the hand-listed heavy files of chat go. The bounds stay: chat's 50 KB, issues'
   3 KB, the shell's 250 KB.
6. **`fold` stays chat's, and 1.9 KB of mention list is chat's by ownership.** `fold` (a comparison without case and marks)
   was moved to `lib/` and put back: with only `fold` imported from the lazy side, the build stopped sharing
   `mention-suggest` as a chunk of its own and folded its 1.9 KB into chat's chunk, 47.8 KB to 50.16 KB, over the bound.
   The bytes are chat's. The palette's matching and the members page import `fold` from the composer, listed with this reason.
   If chat crosses its bound later, the fix is to shrink chat, not to raise the bound.

**Rejected.** *A second lazy chunk for the sidebar's lists and the providers*: measured, see 4. *Moving `sidebar/` and the
providers out of chat into the core to empty the list*: they are chat's lists and chat's uploads, and the core would then name
chat's data. *`eslint-plugin-boundaries`*: a dependency for what `no-restricted-imports` already does for the API's features;
it cannot see a resolved file either. *Only the lint, with the allow-list as a file list*: it cannot tell a listed file's new
import of a screen from its old one. *Counting a type import as no import*: it still couples the files; the build, not the
fence, is what ignores it. *Raising chat's bound by 1.9 KB*: see 6.

**Cost.** One change of 196 files' paths (about 1,200 changed lines of imports, labelled `large-change`) that every open
branch in the web must rebase over; `git log --follow` still finds the history. The chunks and first-load JavaScript are
unchanged (245.86 KB initial, chat 48,991 B before and after the move). **Cost of reversing:** move the folders back; the fence
is data and one test.
