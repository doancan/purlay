# D-14. Desktop is Phase 3, and the memory target is replaced

**Amended 2026-09-09 by D-51**, which settled what the desktop and mobile clients *are*: one
client in a shell, with the bar at polish rather than platform nativeness. Native Swift clients
are not planned, and mobile is an installable progressive web application rather than the separate
"mobile client" this phase list originally implied. **Amended 2026-10-26 by D-186:** the desktop client is a
native Swift application for macOS, and the Tauri shell is not built.

The `<35MB idle` figure is removed from all documents. It is the footprint of an empty Tauri
shell; a React 19 app with a tokenizer and a live socket inside WKWebView realistically idles
at 80–150MB. A requirement that fails on first measurement teaches the team to ignore the
documents. Replaced by D-17.
