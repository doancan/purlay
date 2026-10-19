/**
 * What the first page does not need to read a conversation, in one chunk (D-49, D-159): the
 * settings (D-146) and the image viewer. Each door asks for this module with `import()`, and nothing
 * imports it statically, so none of it counts against the initial budget.
 *
 * **One chunk, not one per feature, because two were measured to cost more than none.** The bundler
 * (rolldown, under Vite 8) folds what a lazy chunk shares with the entry back into the entry when one
 * lazy chunk shares React with it, and does not when two do: it emitted a third, preloaded chunk of
 * every shared module that reaches React, and the split cost the first page 1.9 KB gzipped — more
 * than the viewer itself weighs. A later deferred feature joins this module rather than becoming a
 * second `import()`; `bun run budget:web` says so if it does not.
 */
export { SettingsNav, SettingsScreen } from '../features/settings/settings-screen';
export { ImageViewer } from '../features/messages/image-viewer';
